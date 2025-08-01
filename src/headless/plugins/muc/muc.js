/**
 * @module:headless-plugins-muc-muc
 */
import debounce from 'lodash-es/debounce';
import pick from 'lodash-es/pick';
import sizzle from 'sizzle';
import { getOpenPromise } from '@converse/openpromise';
import { Model } from '@converse/skeletor';
import log from '@converse/log';
import p from '../../utils/parse-helpers';
import _converse from '../../shared/_converse.js';
import api from '../../shared/api/index.js';
import converse from '../../shared/api/public.js';
import {
    ROOMSTATUS,
    OWNER_COMMANDS,
    ADMIN_COMMANDS,
    MODERATOR_COMMANDS,
    VISITOR_COMMANDS,
    ACTION_INFO_CODES,
    NEW_NICK_CODES,
    DISCONNECT_CODES,
} from './constants.js';
import {
    ACTIVE,
    CHATROOMS_TYPE,
    COMPOSING,
    GONE,
    INACTIVE,
    METADATA_ATTRIBUTES,
    PAUSED,
    PRES_SHOW_VALUES,
} from '../../shared/constants.js';
import { Strophe, Stanza, $build } from 'strophe.js';
import { TimeoutError, ItemNotFoundError, StanzaError } from '../../shared/errors.js';
import { computeAffiliationsDelta, setAffiliations, getAffiliationList } from './affiliations/utils.js';
import { initStorage, createStore } from '../../utils/storage.js';
import { isArchived, parseErrorStanza } from '../../shared/parsers.js';
import { getUniqueId } from '../../utils/index.js';
import { safeSave } from '../../utils/init.js';
import { isUniView } from '../../utils/session.js';
import { parseMUCMessage, parseMUCPresence } from './parsers.js';
import { sendMarker } from '../../shared/actions.js';
import ChatBoxBase from '../../shared/chatbox';
import ColorAwareModel from '../../shared/color';
import ModelWithMessages from '../../shared/model-with-messages';
import ModelWithVCard from '../../shared/model-with-vcard';
import { shouldCreateGroupchatMessage, isInfoVisible } from './utils.js';
import MUCSession from './session';

const { u, stx } = converse.env;

/**
 * Represents a groupchat conversation.
 */
class MUC extends ModelWithVCard(ModelWithMessages(ColorAwareModel(ChatBoxBase))) {
    /**
     * @typedef {import('../../shared/message.js').default} BaseMessage
     * @typedef {import('./message.js').default} MUCMessage
     * @typedef {import('./occupant.js').default} MUCOccupant
     * @typedef {import('./types').NonOutcastAffiliation} NonOutcastAffiliation
     * @typedef {import('./types').MemberListItem} MemberListItem
     * @typedef {import('../../shared/types').MessageAttributes} MessageAttributes
     * @typedef {import('./types').MUCMessageAttributes} MUCMessageAttributes
     * @typedef {import('./types').MUCPresenceAttributes} MUCPresenceAttributes
     * @typedef {module:shared.converse.UserMessage} UserMessage
     * @typedef {import('strophe.js').Builder} Builder
     * @typedef {import('../../shared/errors').StanzaParseError} StanzaParseError
     */
    defaults() {
        /** @type {import('./types').DefaultMUCAttributes} */
        return {
            bookmarked: false,
            chat_state: undefined,
            closed: false,
            has_activity: false, // XEP-437
            hidden: isUniView() && !api.settings.get('singleton'),
            hidden_occupants: !!api.settings.get('hide_muc_participants'),
            message_type: 'groupchat',
            name: '',
            // For group chats, we distinguish between generally unread
            // messages and those ones that specifically mention the
            // user.
            //
            // To keep things simple, we reuse `num_unread` from
            // ChatBox to indicate unread messages which
            // mention the user and `num_unread_general` to indicate
            // generally unread messages (which *includes* mentions!).
            num_unread_general: 0,
            num_unread: 0,
            roomconfig: {},
            time_opened: this.get('time_opened') || new Date().getTime(),
            time_sent: new Date(0).toISOString(),
            type: CHATROOMS_TYPE,
        };
    }

    async initialize() {
        super.initialize();
        this.on('change:closed', () => {
            if (!this.get('closed')) {
                this.initialize();
            }
        });
        if (this.get('closed')) return;

        this.initialized = getOpenPromise();
        this.debouncedRejoin = debounce(this.rejoin, 250);

        this.initOccupants();
        this.initDiscoModels(); // sendChatState depends on this.features
        this.registerHandlers();

        this.on('change:chat_state', this.sendChatState, this);
        this.on('change:hidden', this.onHiddenChange, this);
        this.on('destroy', this.removeHandlers, this);

        await this.restoreSession();
        this.session.on('change:connection_status', this.onConnectionStatusChanged, this);

        this.listenTo(this.occupants, 'add', this.onOccupantAdded);
        this.listenTo(this.occupants, 'remove', this.onOccupantRemoved);
        this.listenTo(this.occupants, 'change:presence', this.onOccupantPresenceChanged);
        this.listenTo(this.occupants, 'change:affiliation', this.createAffiliationChangeMessage);
        this.listenTo(this.occupants, 'change:role', this.createRoleChangeMessage);

        const restored = await this.restoreFromCache();
        if (!restored) {
            await this.join();
        }

        /**
         * Triggered once a {@link MUC} has been created and initialized.
         * @event _converse#chatRoomInitialized
         * @type { MUC }
         * @example _converse.api.listen.on('chatRoomInitialized', model => { ... });
         */
        await api.trigger('chatRoomInitialized', this, { synchronous: true });
        this.initialized.resolve();
    }

    isEntered() {
        return this.session?.get('connection_status') === ROOMSTATUS.ENTERED;
    }

    /**
     * Checks whether this MUC qualifies for subscribing to XEP-0437 Room Activity Indicators (RAI)
     * @returns {Boolean}
     */
    isRAICandidate() {
        return this.get('hidden') && api.settings.get('muc_subscribe_to_rai') && this.getOwnAffiliation() !== 'none';
    }

    /**
     * Checks whether we're still joined and if so, restores the MUC state from cache.
     * @returns {Promise<boolean>} Returns `true` if we're still joined, otherwise returns `false`.
     */
    async restoreFromCache() {
        if (this.isEntered()) {
            await this.fetchOccupants().catch(/** @param {Error} e */ (e) => log.error(e));

            if (this.isRAICandidate()) {
                this.session.save('connection_status', ROOMSTATUS.DISCONNECTED);
                this.enableRAI();
                return true;
            } else if (await this.isJoined()) {
                await new Promise((r) => this.config.fetch({ 'success': r, 'error': r }));
                await new Promise((r) => this.features.fetch({ 'success': r, 'error': r }));
                await this.fetchMessages().catch(/** @param {Error} e */ (e) => log.error(e));
                return true;
            }
        }
        this.session.save('connection_status', ROOMSTATUS.DISCONNECTED);
        this.clearOccupantsCache();
        return false;
    }

    /**
     * Join the MUC
     * @param {String} [nick] - The user's nickname
     * @param {String} [password] - Optional password, if required by the groupchat.
     *  Will fall back to the `password` value stored in the room
     *  model (if available).
     *  @returns {Promise<void>}
     */
    async join(nick, password) {
        if (this.isEntered()) {
            // We have restored a groupchat from session storage,
            // so we don't send out a presence stanza again.
            return;
        }
        // Set this early, so we don't rejoin in onHiddenChange
        this.session.save('connection_status', ROOMSTATUS.CONNECTING);

        const is_new = (await this.refreshDiscoInfo()) instanceof ItemNotFoundError;
        nick = await this.getAndPersistNickname(nick);
        if (!nick) {
            safeSave(this.session, { 'connection_status': ROOMSTATUS.NICKNAME_REQUIRED });
            if (!is_new && api.settings.get('muc_show_logs_before_join')) {
                await this.fetchMessages();
            }
            return;
        }
        api.send(await this.constructJoinPresence(password, is_new));
        if (is_new) await this.refreshDiscoInfo();
    }

    /**
     * Clear stale cache and re-join a MUC we've been in before.
     */
    rejoin() {
        this.session.save('connection_status', ROOMSTATUS.DISCONNECTED);
        this.registerHandlers();
        this.clearOccupantsCache();
        return this.join();
    }

    /**
     * @param {string} password
     * @param {boolean} is_new
     */
    async constructJoinPresence(password, is_new) {
        const maxstanzas = is_new || this.features.get('mam_enabled') ? 0 : api.settings.get('muc_history_max_stanzas');
        password = password || this.get('password');

        const { profile } = _converse.state;
        const show = profile.get('show');
        const status_message = profile.get('status_message');
        const stanza = stx`
            <presence xmlns="jabber:client"
                      id="${getUniqueId()}"
                      from="${api.connection.get().jid}"
                      to="${this.getRoomJIDAndNick()}">
                <x xmlns="${Strophe.NS.MUC}">
                    <history maxstanzas="${maxstanzas}"/>
                    ${password ? stx`<password>${password}</password>` : ''}
                </x>
                ${PRES_SHOW_VALUES.includes(show) ? stx`<show>${show}</show>` : ''}
                ${status_message ? stx`<status>${status_message}</status>` : ''}
            </presence>`;
        /**
         * *Hook* which allows plugins to update an outgoing MUC join presence stanza
         * @event _converse#constructedMUCPresence
         * @type {Element} The stanza which will be sent out
         */
        return await api.hook('constructedMUCPresence', this, stanza);
    }

    clearOccupantsCache() {
        if (this.occupants.length) {
            // Remove non-members when reconnecting
            this.occupants.filter((o) => !o.isMember()).forEach((o) => o.destroy());
        } else {
            // Looks like we haven't restored occupants from cache, so we clear it.
            this.occupants.clearStore();
        }
    }

    /**
     * Given the passed in MUC message, send a XEP-0333 chat marker.
     * @async
     * @param {BaseMessage} msg
     * @param {('received'|'displayed'|'acknowledged')} [type='displayed']
     * @param {boolean} [force=false] - Whether a marker should be sent for the
     *  message, even if it didn't include a `markable` element.
     */
    sendMarkerForMessage(msg, type = 'displayed', force = false) {
        if (!msg || !api.settings.get('send_chat_markers').includes(type) || msg?.get('type') !== 'groupchat') {
            return;
        }
        if (msg?.get('is_markable') || force) {
            const key = `stanza_id ${this.get('jid')}`;
            const id = msg.get(key);
            if (!id) {
                log.error(`Can't send marker for message without stanza ID: ${key}`);
                return Promise.resolve();
            }
            const from_jid = Strophe.getBareJidFromJid(msg.get('from'));
            sendMarker(from_jid, id, type, msg.get('type'));
        }
        return Promise.resolve();
    }

    /**
     * Finds the last eligible message and then sends a XEP-0333 chat marker for it.
     * @param { ('received'|'displayed'|'acknowledged') } [type='displayed']
     * @param {Boolean} force - Whether a marker should be sent for the
     *  message, even if it didn't include a `markable` element.
     */
    sendMarkerForLastMessage(type = 'displayed', force = false) {
        const msgs = Array.from(this.messages.models);
        msgs.reverse();
        const msg = msgs.find((m) => m.get('sender') === 'them' && (force || m.get('is_markable')));
        msg && this.sendMarkerForMessage(msg, type, force);
    }

    /**
     * Ensures that the user is subscribed to XEP-0437 Room Activity Indicators
     * if `muc_subscribe_to_rai` is set to `true`.
     * Only affiliated users can subscribe to RAI, but this method doesn't
     * check whether the current user is affiliated because it's intended to be
     * called after the MUC has been left and we don't have that information anymore.
     */
    enableRAI() {
        if (api.settings.get('muc_subscribe_to_rai')) {
            const muc_domain = Strophe.getDomainFromJid(this.get('jid'));
            api.user.presence.send({ to: muc_domain }, $build('rai', { 'xmlns': Strophe.NS.RAI }));
        }
    }

    /**
     * Handler that gets called when the 'hidden' flag is toggled.
     */
    async onHiddenChange() {
        const roomstatus = ROOMSTATUS;
        const conn_status = this.session.get('connection_status');
        if (this.get('hidden')) {
            if (conn_status === roomstatus.ENTERED) {
                this.setChatState(INACTIVE);

                if (this.isRAICandidate()) {
                    this.sendMarkerForLastMessage('received', true);
                    await this.leave();
                    this.enableRAI();
                }
            }
        } else {
            await this.initialized;
            if (conn_status === roomstatus.DISCONNECTED) this.rejoin();
            this.clearUnreadMsgCounter();
        }
    }

    /**
     * @param {MUCOccupant} occupant
     */
    onOccupantAdded(occupant) {
        if (
            isInfoVisible(converse.MUC_TRAFFIC_STATES.ENTERED) &&
            this.session.get('connection_status') === ROOMSTATUS.ENTERED &&
            occupant.get('presence') === 'online'
        ) {
            this.updateNotifications(occupant.get('nick'), converse.MUC_TRAFFIC_STATES.ENTERED);
        }
    }

    /**
     * @param {MUCOccupant} occupant
     */
    onOccupantRemoved(occupant) {
        if (
            isInfoVisible(converse.MUC_TRAFFIC_STATES.EXITED) &&
            this.isEntered() &&
            occupant.get('presence') === 'online'
        ) {
            this.updateNotifications(occupant.get('nick'), converse.MUC_TRAFFIC_STATES.EXITED);
        }
    }

    /**
     * @param {MUCOccupant} occupant
     */
    onOccupantPresenceChanged(occupant) {
        if (occupant.get('states').includes('303')) {
            return;
        }
        if (occupant.get('presence') === 'offline' && isInfoVisible(converse.MUC_TRAFFIC_STATES.EXITED)) {
            this.updateNotifications(occupant.get('nick'), converse.MUC_TRAFFIC_STATES.EXITED);
        } else if (occupant.get('presence') === 'online' && isInfoVisible(converse.MUC_TRAFFIC_STATES.ENTERED)) {
            this.updateNotifications(occupant.get('nick'), converse.MUC_TRAFFIC_STATES.ENTERED);
        }
    }

    async onRoomEntered() {
        await this.occupants.fetchMembers();
        if (api.settings.get('clear_messages_on_reconnection')) {
            await this.clearMessages();
        } else {
            await this.fetchMessages();
        }
        /**
         * Triggered when the user has entered a new MUC
         * @event _converse#enteredNewRoom
         * @type {MUC}
         * @example _converse.api.listen.on('enteredNewRoom', model => { ... });
         */
        api.trigger('enteredNewRoom', this);
        if (
            api.settings.get('auto_register_muc_nickname') &&
            (await api.disco.supports(Strophe.NS.MUC_REGISTER, this.get('jid')))
        ) {
            this.registerNickname();
        }
    }

    async onConnectionStatusChanged() {
        if (this.isEntered()) {
            if (this.isRAICandidate()) {
                try {
                    await this.leave();
                } catch (e) {
                    log.error(e);
                }
                this.enableRAI();
            } else {
                await this.onRoomEntered();
            }
        }
    }

    async onReconnection() {
        await this.rejoin();
        this.announceReconnection();
    }

    getMessagesCollection() {
        return new _converse.exports.MUCMessages();
    }

    restoreSession() {
        const bare_jid = _converse.session.get('bare_jid');
        const id = `muc.session-${bare_jid}-${this.get('jid')}`;
        this.session = new MUCSession({ id });
        initStorage(this.session, id, 'session');
        return new Promise((r) => this.session.fetch({ 'success': r, 'error': r }));
    }

    initDiscoModels() {
        const bare_jid = _converse.session.get('bare_jid');
        let id = `converse.muc-features-${bare_jid}-${this.get('jid')}`;
        this.features = new Model(
            Object.assign(
                { id },
                converse.ROOM_FEATURES.reduce((acc, feature) => {
                    acc[feature] = false;
                    return acc;
                }, {})
            )
        );
        this.features.browserStorage = createStore(id, 'session');
        this.features.listenTo(_converse, 'beforeLogout', () => this.features.browserStorage.flush());

        id = `converse.muc-config-${bare_jid}-${this.get('jid')}`;
        this.config = new Model({ id });
        this.config.browserStorage = createStore(id, 'session');
        this.config.listenTo(_converse, 'beforeLogout', () => this.config.browserStorage.flush());
    }

    initOccupants() {
        this.occupants = new _converse.exports.MUCOccupants();
        const bare_jid = _converse.session.get('bare_jid');
        const id = `converse.occupants-${bare_jid}${this.get('jid')}`;
        this.occupants.browserStorage = createStore(id, 'session');
        this.occupants.chatroom = this;
        this.occupants.listenTo(_converse, 'beforeLogout', () => this.occupants.browserStorage.flush());
    }

    fetchOccupants() {
        this.occupants.fetched = new Promise((resolve) => {
            this.occupants.fetch({
                'add': true,
                'silent': true,
                'success': resolve,
                'error': resolve,
            });
        });
        return this.occupants.fetched;
    }

    /**
     * If a user's affiliation has been changed, a <presence> stanza is sent
     * out, but if the user is not in a room, a <message> stanza MAY be sent
     * out. This handler handles such message stanzas. See "Example 176" in
     * XEP-0045.
     * @param {Element} stanza
     * @returns {void}
     */
    handleAffiliationChangedMessage(stanza) {
        if (stanza.querySelector('body')) {
            // If there's a body, we don't treat it as an affiliation change message.
            return;
        }

        const item = sizzle(`x[xmlns="${Strophe.NS.MUC_USER}"] item`, stanza).pop();
        if (item) {
            const from = stanza.getAttribute('from');
            const jid = item.getAttribute('jid');
            const data = {
                from,
                states: [],
                jid: Strophe.getBareJidFromJid(jid),
                resource: Strophe.getResourceFromJid(jid),
            };

            const affiliation = item.getAttribute('affiliation');
            if (affiliation) {
                data.affiliation = affiliation;
            }

            const role = item.getAttribute('role');
            if (role) {
                data.role = role;
            }

            const occupant = this.occupants.findOccupant({ jid: data.jid });
            if (occupant) {
                occupant.save(data);
            } else {
                this.occupants.create(data);
            }
        }
    }

    /**
     * @param {Element} stanza
     */
    async handleErrorMessageStanza(stanza) {
        const { __ } = _converse;

        const attrs_or_error = await parseMUCMessage(stanza, this);
        if (u.isErrorObject(attrs_or_error)) {
            const { stanza, message } = /** @type {StanzaParseError} */ (attrs_or_error);
            if (stanza) log.error(stanza);
            return log.error(message);
        }

        const attrs = /** @type {MessageAttributes} */ (attrs_or_error);

        if (!(await this.shouldShowErrorMessage(attrs))) {
            return;
        }

        const nick = Strophe.getResourceFromJid(attrs.from);
        const occupant = nick ? this.getOccupant(nick) : null;

        const model = occupant ? occupant : this;

        const message = model.getMessageReferencedByError(attrs);
        if (message) {
            const new_attrs = {
                error: attrs.error,
                error_condition: attrs.error_condition,
                error_text: attrs.error_text,
                error_type: attrs.error_type,
                editable: false,
            };
            if (attrs.msgid === message.get('retraction_id')) {
                // The error message refers to a retraction
                new_attrs.retracted = undefined;
                new_attrs.retraction_id = undefined;
                new_attrs.retracted_id = undefined;

                if (!attrs.error) {
                    if (attrs.error_condition === 'forbidden') {
                        new_attrs.error = __("You're not allowed to retract your message.");
                    } else if (attrs.error_condition === 'not-acceptable') {
                        new_attrs.error = __(
                            "Your retraction was not delivered because you're not present in the groupchat."
                        );
                    } else {
                        new_attrs.error = __('Sorry, an error occurred while trying to retract your message.');
                    }
                }
            } else if (!attrs.error) {
                if (attrs.error_condition === 'forbidden') {
                    new_attrs.error = __("Your message was not delivered because you weren't allowed to send it.");
                } else if (attrs.error_condition === 'not-acceptable') {
                    new_attrs.error = __("Your message was not delivered because you're not present in the groupchat.");
                } else {
                    new_attrs.error = __('Sorry, an error occurred while trying to send your message.');
                }
            }
            message.save(new_attrs);
        } else {
            model.createMessage(attrs);
        }
    }

    /**
     * Handles incoming message stanzas from the service that hosts this MUC
     * @param {Element} stanza
     */
    handleMessageFromMUCHost(stanza) {
        if (this.isEntered()) {
            // We're not interested in activity indicators when already joined to the room
            return;
        }
        const rai = sizzle(`rai[xmlns="${Strophe.NS.RAI}"]`, stanza).pop();
        const active_mucs = Array.from(rai?.querySelectorAll('activity') || []).map((m) => m.textContent);
        if (active_mucs.includes(this.get('jid'))) {
            this.save({
                'has_activity': true,
                'num_unread_general': 0, // Either/or between activity and unreads
            });
        }
    }

    /**
     * Handles XEP-0452 MUC Mention Notification messages
     * @param {Element} stanza
     */
    handleForwardedMentions(stanza) {
        if (this.isEntered()) {
            // Avoid counting mentions twice
            return;
        }
        const msgs = sizzle(
            `mentions[xmlns="${Strophe.NS.MENTIONS}"] forwarded[xmlns="${Strophe.NS.FORWARD}"] message[type="groupchat"]`,
            stanza
        );
        const muc_jid = this.get('jid');
        const mentions = msgs.filter((m) => Strophe.getBareJidFromJid(m.getAttribute('from')) === muc_jid);
        if (mentions.length) {
            this.save({
                'has_activity': true,
                'num_unread': this.get('num_unread') + mentions.length,
            });
            mentions.forEach(
                /** @param {Element} stanza */ async (stanza) => {
                    const attrs = await parseMUCMessage(stanza, this);
                    const data = { stanza, attrs, 'chatbox': this };
                    api.trigger('message', data);
                }
            );
        }
    }

    /**
     * Parses an incoming message stanza and queues it for processing.
     * @param {Builder|Element} stanza
     */
    async handleMessageStanza(stanza) {
        stanza = /** @type {Builder} */ (stanza).tree?.() ?? /** @type {Element} */ (stanza);

        const type = stanza.getAttribute('type');
        if (type === 'error') {
            return this.handleErrorMessageStanza(stanza);
        }
        if (type === 'groupchat') {
            if (isArchived(stanza)) {
                // MAM messages are handled in converse-mam.
                // We shouldn't get MAM messages here because
                // they shouldn't have a `type` attribute.
                return log.warn(`Received a MAM message with type "groupchat"`);
            }
        } else if (!type) {
            return this.handleForwardedMentions(stanza);
        }

        let attrs_or_error;
        try {
            attrs_or_error = await parseMUCMessage(stanza, this);
        } catch (e) {
            return log.error(e);
        }

        if (u.isErrorObject(attrs_or_error)) {
            const { stanza, message } = /** @type {StanzaParseError} */ (attrs_or_error);
            if (stanza) log.error(stanza);
            return log.error(message);
        }

        const attrs = /** @type {MUCMessageAttributes} */ (attrs_or_error);
        if (attrs.type === 'groupchat') {
            attrs.codes.forEach((code) => this.createInfoMessage(code));
            this.fetchFeaturesIfConfigurationChanged(attrs);
        }

        const data = /** @type {import('./types').MUCMessageEventData} */ ({
            stanza,
            attrs,
            chatbox: this,
        });
        /**
         * Triggered when a groupchat message stanza has been received and parsed.
         * @event _converse#message
         * @type {object}
         * @property {import('./types').MUCMessageEventData} data
         */
        api.trigger('message', data);
        return attrs && this.queueMessage(attrs);
    }

    /**
     * Register presence and message handlers relevant to this groupchat
     */
    registerHandlers() {
        const muc_jid = this.get('jid');
        const muc_domain = Strophe.getDomainFromJid(muc_jid);
        this.removeHandlers();
        const connection = api.connection.get();
        this.presence_handler = connection.addHandler(
            /** @param {Element} stanza */ (stanza) => {
                this.onPresence(stanza);
                return true;
            },
            null,
            'presence',
            null,
            null,
            muc_jid,
            { 'ignoreNamespaceFragment': true, 'matchBareFromJid': true }
        );

        this.domain_presence_handler = connection.addHandler(
            /** @param {Element} stanza */ (stanza) => {
                this.onPresenceFromMUCHost(stanza);
                return true;
            },
            null,
            'presence',
            null,
            null,
            muc_domain
        );

        this.message_handler = connection.addHandler(
            /** @param {Element} stanza */ (stanza) => {
                this.handleMessageStanza(stanza);
                return true;
            },
            null,
            'message',
            null,
            null,
            muc_jid,
            { 'matchBareFromJid': true }
        );

        this.domain_message_handler = connection.addHandler(
            /** @param {Element} stanza */ (stanza) => {
                this.handleMessageFromMUCHost(stanza);
                return true;
            },
            null,
            'message',
            null,
            null,
            muc_domain
        );

        this.affiliation_message_handler = connection.addHandler(
            /** @param {Element} stanza */
            (stanza) => {
                this.handleAffiliationChangedMessage(stanza);
                return true;
            },
            Strophe.NS.MUC_USER,
            'message',
            null,
            null,
            muc_jid
        );
    }

    removeHandlers() {
        const connection = api.connection.get();
        // Remove the presence and message handlers that were
        // registered for this groupchat.
        if (this.message_handler) {
            connection?.deleteHandler(this.message_handler);
            delete this.message_handler;
        }
        if (this.domain_message_handler) {
            connection?.deleteHandler(this.domain_message_handler);
            delete this.domain_message_handler;
        }
        if (this.presence_handler) {
            connection?.deleteHandler(this.presence_handler);
            delete this.presence_handler;
        }
        if (this.domain_presence_handler) {
            connection?.deleteHandler(this.domain_presence_handler);
            delete this.domain_presence_handler;
        }
        if (this.affiliation_message_handler) {
            connection?.deleteHandler(this.affiliation_message_handler);
            delete this.affiliation_message_handler;
        }
        return this;
    }

    invitesAllowed() {
        return (
            api.settings.get('allow_muc_invitations') &&
            (this.features.get('open') || this.getOwnAffiliation() === 'owner')
        );
    }

    getDisplayName() {
        const name = this.get('name');
        if (name) {
            return name.trim();
        } else if (api.settings.get('locked_muc_domain') === 'hidden') {
            return Strophe.getNodeFromJid(this.get('jid'));
        } else {
            return this.get('jid');
        }
    }

    /**
     * Sends a message stanza to the XMPP server and expects a reflection
     * or error message within a specific timeout period.
     * @param {Builder|Element } message
     * @returns { Promise<Element>|Promise<TimeoutError> } Returns a promise
     *  which resolves with the reflected message stanza or with an error stanza or
     *  {@link TimeoutError}.
     */
    sendTimedMessage(message) {
        const el = message instanceof Element ? message : message.tree();
        let id = el.getAttribute('id');
        if (!id) {
            // inject id if not found
            id = getUniqueId('sendIQ');
            el.setAttribute('id', id);
        }
        const promise = getOpenPromise();
        const timeout = api.settings.get('stanza_timeout');
        const connection = api.connection.get();
        const timeoutHandler = connection.addTimedHandler(timeout, () => {
            connection.deleteHandler(handler);
            const err = new TimeoutError('Timeout Error: No response from server');
            promise.resolve(err);
            return false;
        });
        const handler = connection.addHandler(
            /** @param {Element} stanza */
            (stanza) => {
                timeoutHandler && connection.deleteTimedHandler(timeoutHandler);
                promise.resolve(stanza);
            },
            null,
            'message',
            ['error', 'groupchat'],
            id
        );
        api.send(el);
        return promise;
    }

    /**
     * Retract one of your messages in this groupchat
     * @param {BaseMessage} message - The message which we're retracting.
     */
    async retractOwnMessage(message) {
        const __ = _converse.__;
        const editable = message.get('editable');
        const retraction_id = getUniqueId();
        const id = message.get('id');

        const stanza = stx`
            <message id="${retraction_id}"
                     to="${this.get('jid')}"
                     type="groupchat"
                     xmlns="jabber:client">
                <retract id="${id}" xmlns="${Strophe.NS.RETRACT}"/>
                <body>/me retracted a message</body>
                <store xmlns="${Strophe.NS.HINTS}"/>
                <fallback xmlns="${Strophe.NS.FALLBACK}" for="${Strophe.NS.RETRACT}" />
            </message>`;

        // Optimistic save
        message.set({
            retracted: new Date().toISOString(),
            retracted_id: id,
            retraction_id: retraction_id,
            editable: false,
        });
        const result = await this.sendTimedMessage(stanza);

        if (u.isErrorStanza(result)) {
            log.error(result);
        } else if (result instanceof TimeoutError) {
            log.error(result);
            message.save({
                editable,
                error_type: 'timeout',
                error: __('A timeout happened while trying to retract your message.'),
                retracted: undefined,
                retracted_id: undefined,
                retraction_id: undefined,
            });
        }
    }

    /**
     * Retract someone else's message in this groupchat.
     * @param {MUCMessage} message - The message which we're retracting.
     * @param {string} [reason] - The reason for retracting the message.
     * @example
     *  const room = await api.rooms.get(jid);
     *  const message = room.messages.findWhere({'body': 'Get rich quick!'});
     *  room.retractOtherMessage(message, 'spam');
     */
    async retractOtherMessage(message, reason) {
        const editable = message.get('editable');
        const bare_jid = _converse.session.get('bare_jid');
        // Optimistic save
        message.save({
            moderated: 'retracted',
            moderated_by: bare_jid,
            moderated_id: message.get('msgid'),
            moderation_reason: reason,
            editable: false,
        });
        const result = await this.sendRetractionIQ(message, reason);
        if (result === null || u.isErrorStanza(result)) {
            // Undo the save if something went wrong
            message.save({
                editable,
                moderated: undefined,
                moderated_by: undefined,
                moderated_id: undefined,
                moderation_reason: undefined,
            });
        }
        return result;
    }

    /**
     * Sends an IQ stanza to the XMPP server to retract a message in this groupchat.
     * @param {MUCMessage} message - The message which we're retracting.
     * @param {string} [reason] - The reason for retracting the message.
     */
    sendRetractionIQ(message, reason) {
        const iq = stx`
            <iq to="${this.get('jid')}" type="set" xmlns="jabber:client">
                <moderate id="${message.get(`stanza_id ${this.get('jid')}`)}" xmlns="${Strophe.NS.MODERATE}">
                    <retract xmlns="${Strophe.NS.RETRACT}"/>
                    ${reason ? stx`<reason>${reason}</reason>` : ''}
                </moderate>
            </iq>`;
        return api.sendIQ(iq, null, false);
    }

    /**
     * Sends an IQ stanza to the XMPP server to destroy this groupchat. Not
     * to be confused with the {@link MUC#destroy}
     * method, which simply removes the room from the local browser storage cache.
     * @param {string} [reason] - The reason for destroying the groupchat.
     * @param {string} [new_jid] - The JID of the new groupchat which replaces this one.
     */
    sendDestroyIQ(reason, new_jid) {
        const iq = stx`
            <iq to="${this.get('jid')}" type="set" xmlns="jabber:client">
                <query xmlns="${Strophe.NS.MUC_OWNER}">
                    <destroy ${new_jid ? Stanza.unsafeXML(`jid="${Strophe.xmlescape(new_jid)}"`) : ''}>
                        ${reason ? stx`<reason>${reason}</reason>` : ''}
                    </destroy>
                </query>
            </iq>`;
        return api.sendIQ(iq);
    }

    /**
     * Leave the groupchat by sending an unavailable presence stanza, and then
     * tear down the features and disco collections so that they'll be
     * recreated if/when we rejoin.
     * @param {string} [exit_msg] - Message to indicate your reason for leaving
     */
    async leave(exit_msg) {
        api.user.presence.send({
            type: 'unavailable',
            to: this.getRoomJIDAndNick(),
            status: exit_msg,
        });

        safeSave(this.session, { connection_status: ROOMSTATUS.DISCONNECTED });

        // Delete the features model
        if (this.features) {
            await new Promise((resolve) =>
                this.features.destroy({
                    success: resolve,
                    error: (_, e) => {
                        log.error(e);
                        resolve();
                    },
                })
            );
        }
        // Delete disco entity
        const disco_entity = _converse.state.disco_entities?.get(this.get('jid'));
        if (disco_entity) {
            await new Promise((resolve) =>
                disco_entity.destroy({
                    success: resolve,
                    error: (_, e) => {
                        log.error(e);
                        resolve();
                    },
                })
            );
        }
    }

    /**
     * @typedef {Object} CloseEvent
     * @property {string} name
     * @param {CloseEvent} [ev]
     */
    async close(ev) {
        const { ENTERED, CLOSING } = ROOMSTATUS;
        const was_entered = this.session.get('connection_status') === ENTERED;

        safeSave(this.session, { connection_status: CLOSING });
        was_entered && this.sendMarkerForLastMessage('received', true);
        await this.leave();

        this.occupants.clearStore();

        const is_closed_by_user = ev?.name !== 'closeAllChatBoxes';
        if (is_closed_by_user) {
            await this.unregisterNickname();
            if (api.settings.get('muc_clear_messages_on_leave')) {
                this.clearMessages();
            }
            /**
             * Triggered when the user leaves a MUC
             * @event _converse#leaveRoom
             * @type {MUC}
             * @example _converse.api.listen.on('leaveRoom', model => { ... });
             */
            api.trigger('leaveRoom', this);
        }

        // Delete the session model
        await new Promise((success) =>
            this.session.destroy({
                success,
                error: (_, e) => {
                    log.error(e);
                    success();
                },
            })
        );
        return super.close();
    }

    canModerateMessages() {
        const self = this.getOwnOccupant();
        return self && self.isModerator() && api.disco.supports(Strophe.NS.MODERATE, this.get('jid'));
    }

    canPostMessages() {
        return this.isEntered() && !(this.features.get('moderated') && this.getOwnRole() === 'visitor');
    }

    /**
     * @param {import('../../shared/message').default} message
     */
    isChatMessage(message) {
        return message.get('type') === this.get('message_type');
    }

    /**
     * Return an array of unique nicknames based on all occupants and messages in this MUC.
     * @returns {String[]}
     */
    getAllKnownNicknames() {
        return [
            ...new Set([...this.occupants.map((o) => o.get('nick')), ...this.messages.map((m) => m.get('nick'))]),
        ].filter((n) => n);
    }

    getAllKnownNicknamesRegex() {
        const longNickString = this.getAllKnownNicknames()
            .map((n) => p.escapeRegexString(n))
            .join('|');
        return RegExp(`(?:\\p{P}|\\p{Z}|^)@(${longNickString})(?![\\w@-])`, 'uig');
    }

    /**
     * @param {string} jid
     */
    getOccupantByJID(jid) {
        return this.occupants.findOccupant({ jid });
    }

    /**
     * @param {string} nick
     */
    getOccupantByNickname(nick) {
        return this.occupants.findOccupant({ nick });
    }

    /**
     * @param {string} nick
     */
    getReferenceURIFromNickname(nick) {
        const muc_jid = this.get('jid');
        const occupant = this.getOccupant(nick);
        const uri = (this.features.get('nonanonymous') && occupant?.get('jid')) || `${muc_jid}/${nick}`;
        return encodeURI(`xmpp:${uri}`);
    }

    /**
     * Given a text message, look for `@` mentions and turn them into
     * XEP-0372 references
     * @param { String } text
     */
    parseTextForReferences(text) {
        const mentions_regex = /(\p{P}|\p{Z}|^)([@][\w_-]+(?:\.\w+)*)/giu;
        if (!text || !mentions_regex.test(text)) {
            return [text, []];
        }

        const getMatchingNickname = p.findFirstMatchInArray(this.getAllKnownNicknames());

        const matchToReference = (match) => {
            let at_sign_index = match[0].indexOf('@');
            if (match[0][at_sign_index + 1] === '@') {
                // edge-case
                at_sign_index += 1;
            }
            const begin = match.index + at_sign_index;
            const end = begin + match[0].length - at_sign_index;
            const value = getMatchingNickname(match[1]);
            const type = 'mention';
            const uri = this.getReferenceURIFromNickname(value);
            return { begin, end, value, type, uri };
        };

        const regex = this.getAllKnownNicknamesRegex();
        const mentions = [...text.matchAll(regex)].filter((m) => !m[0].startsWith('/'));
        const references = mentions.map(matchToReference);

        const [updated_message, updated_references] = p.reduceTextFromReferences(text, references);
        return [updated_message, updated_references];
    }

    /**
     * @param {MessageAttributes} [attrs] - A map of attributes to be saved on the message
     */
    async getOutgoingMessageAttributes(attrs) {
        const is_spoiler = this.get('composing_spoiler');
        let text = '',
            references;
        if (attrs?.body) {
            [text, references] = this.parseTextForReferences(attrs.body);
        }
        const origin_id = getUniqueId();
        const body = text ? u.shortnamesToUnicode(text) : undefined;
        attrs = Object.assign(
            {},
            attrs,
            {
                body,
                is_spoiler,
                origin_id,
                references,
                id: origin_id,
                msgid: origin_id,
                from: `${this.get('jid')}/${this.get('nick')}`,
                fullname: this.get('nick'),
                message: body,
                nick: this.get('nick'),
                sender: 'me',
                type: 'groupchat',
                original_text: text,
            },
            await u.getMediaURLsMetadata(text)
        );

        /**
         * *Hook* which allows plugins to update the attributes of an outgoing
         * message.
         * @event _converse#getOutgoingMessageAttributes
         */
        attrs = await api.hook('getOutgoingMessageAttributes', this, attrs);
        return attrs;
    }

    /**
     * Utility method to construct the JID for the current user as occupant of the groupchat.
     * @returns {string} - The groupchat JID with the user's nickname added at the end.
     * @example groupchat@conference.example.org/nickname
     */
    getRoomJIDAndNick() {
        const nick = this.get('nick');
        const jid = Strophe.getBareJidFromJid(this.get('jid'));
        return jid + (nick !== null ? `/${nick}` : '');
    }

    /**
     * Sends a message with the current XEP-0085 chat state of the user
     * as taken from the `chat_state` attribute of the {@link MUC}.
     */
    sendChatState() {
        if (
            !api.settings.get('send_chat_state_notifications') ||
            !this.get('chat_state') ||
            !this.isEntered() ||
            (this.features.get('moderated') && this.getOwnRole() === 'visitor')
        ) {
            return;
        }
        const allowed = api.settings.get('send_chat_state_notifications');
        if (Array.isArray(allowed) && !allowed.includes(this.get('chat_state'))) {
            return;
        }
        const chat_state = this.get('chat_state');
        if (chat_state === GONE) return; // <gone/> is not applicable within MUC context

        api.send(stx`
            <message to="${this.get('jid')}" type="groupchat" xmlns="jabber:client">
                ${chat_state === INACTIVE ? stx`<inactive xmlns="${Strophe.NS.CHATSTATES}"/>` : ''}
                ${chat_state === ACTIVE ? stx`<active xmlns="${Strophe.NS.CHATSTATES}"/>` : ''}
                ${chat_state === COMPOSING ? stx`<composing xmlns="${Strophe.NS.CHATSTATES}"/>` : ''}
                ${chat_state === PAUSED ? stx`<paused xmlns="${Strophe.NS.CHATSTATES}"/>` : ''}
                <no-store xmlns="${Strophe.NS.HINTS}"/>
                <no-permanent-store xmlns="${Strophe.NS.HINTS}"/>
            </message>`);
    }

    /**
     * Send a direct invitation as per XEP-0249
     * @param {String} recipient - JID of the person being invited
     * @param {String} [reason] - Reason for the invitation
     */
    directInvite(recipient, reason) {
        if (this.features.get('membersonly')) {
            // When inviting to a members-only groupchat, we first add
            // the person to the member list by giving them an
            // affiliation of 'member' otherwise they won't be able to join.
            this.updateMemberLists([{ jid: recipient, affiliation: 'member', reason }]);
        }
        const invitation = stx`
            <message xmlns="jabber:client" to="${recipient}" id="${getUniqueId()}">
                <x xmlns="jabber:x:conference"
                    jid="${this.get('jid')}"
                    ${this.get('password') ? Stanza.unsafeXML(`password="${Strophe.xmlescape(this.get('password'))}"`) : ''}
                    ${reason ? Stanza.unsafeXML(`reason="${Strophe.xmlescape(reason)}"`) : ''} />
            </message>`;
        api.send(invitation);
        /**
         * After the user has sent out a direct invitation (as per XEP-0249),
         * to a roster contact, asking them to join a room.
         * @event _converse#chatBoxMaximized
         * @type {object}
         * @property {MUC} room
         * @property {string} recipient - The JID of the person being invited
         * @property {string} reason - The original reason for the invitation
         * @example _converse.api.listen.on('chatBoxMaximized', view => { ... });
         */
        api.trigger('roomInviteSent', {
            room: this,
            recipient,
            reason,
        });
    }

    /**
     * Refresh the disco identity, features and fields for this {@link MUC}.
     * *features* are stored on the features {@link Model} attribute on this {@link MUC}.
     * *fields* are stored on the config {@link Model} attribute on this {@link MUC}.
     * @returns {Promise}
     */
    async refreshDiscoInfo() {
        const result = await api.disco.refresh(this.get('jid'));
        if (result instanceof StanzaError) {
            return result;
        }
        return this.getDiscoInfo().catch((e) => log.error(e));
    }

    /**
     * Fetch the *extended* MUC info from the server and cache it locally
     * https://xmpp.org/extensions/xep-0045.html#disco-roominfo
     * @returns {Promise}
     */
    async getDiscoInfo() {
        const identity = await api.disco.getIdentity('conference', 'text', this.get('jid'));
        if (identity?.get('name')) {
            this.save({ name: identity.get('name') });
        } else {
            log.error(`No identity or name found for ${this.get('jid')}`);
        }
        await this.getDiscoInfoFields();
        await this.getDiscoInfoFeatures();
    }

    /**
     * Fetch the *extended* MUC info fields from the server and store them locally
     * in the `config` {@link Model} attribute.
     * See: https://xmpp.org/extensions/xep-0045.html#disco-roominfo
     * @returns {Promise}
     */
    async getDiscoInfoFields() {
        const fields = await api.disco.getFields(this.get('jid'));

        const config = fields.reduce((config, f) => {
            const name = f.get('var');
            if (name === 'muc#roomconfig_roomname') {
                config['roomname'] = f.get('value');
            }
            if (name?.startsWith('muc#roominfo_')) {
                config[name.replace('muc#roominfo_', '')] = f.get('value');
            }
            return config;
        }, {});

        this.config.save(config);
        if (config['roomname']) this.save({ name: config['roomname'] });
    }

    /**
     * Use converse-disco to populate the features {@link Model} which
     * is stored as an attibute on this {@link MUC}.
     * The results may be cached. If you want to force fetching the features from the
     * server, call {@link MUC#refreshDiscoInfo} instead.
     * @returns {Promise}
     */
    async getDiscoInfoFeatures() {
        const features = await api.disco.getFeatures(this.get('jid'));

        const attrs = converse.ROOM_FEATURES.reduce(
            (acc, feature) => {
                acc[feature] = false;
                return acc;
            },
            { 'fetched': new Date().toISOString() }
        );

        features.each((feature) => {
            const fieldname = feature.get('var');
            if (!fieldname.startsWith('muc_')) {
                if (fieldname === Strophe.NS.MAM) {
                    attrs.mam_enabled = true;
                } else {
                    attrs[fieldname] = true;
                }
                return;
            }
            attrs[fieldname.replace('muc_', '')] = true;
        });
        this.features.save(attrs);
    }

    /**
     * Given a <field> element, return a copy with a <value> child if
     * we can find a value for it in this rooms config.
     * @param {Element} field
     * @returns {Element}
     */
    addFieldValue(field) {
        const type = field.getAttribute('type');
        if (type === 'fixed') {
            return field;
        }
        const fieldname = field.getAttribute('var').replace('muc#roomconfig_', '');
        const config = this.get('roomconfig');
        if (fieldname in config) {
            let values;
            switch (type) {
                case 'boolean':
                    values = [config[fieldname] ? 1 : 0];
                    break;
                case 'list-multi':
                    values = config[fieldname];
                    break;
                default:
                    values = [config[fieldname]];
            }
            field.innerHTML = values.map((v) => $build('value').t(v)).join('');
        }
        return field;
    }

    /**
     * Automatically configure the groupchat based on this model's
     * 'roomconfig' data.
     * @returns {Promise<Element>}
     * Returns a promise which resolves once a response IQ has
     * been received.
     */
    async autoConfigureChatRoom() {
        const stanza = await this.fetchRoomConfiguration();
        const fields = sizzle('field', stanza);
        const configArray = fields.map((f) => this.addFieldValue(f));
        if (configArray.length) {
            return this.sendConfiguration(configArray);
        }
    }

    /**
     * Send an IQ stanza to fetch the groupchat configuration data.
     * Returns a promise which resolves once the response IQ
     * has been received.
     * @returns {Promise<Element>}
     */
    fetchRoomConfiguration() {
        return api.sendIQ(stx`
            <iq to="${this.get('jid')}" type="get" xmlns="jabber:client">
                <query xmlns="${Strophe.NS.MUC_OWNER}"/>
            </iq>`);
    }

    /**
     * Sends an IQ stanza with the groupchat configuration.
     * @param {Element[]} config - The groupchat configuration
     * @returns {Promise<Element>} - A promise which resolves with
     *  the `result` stanza received from the XMPP server.
     */
    sendConfiguration(config = []) {
        const iq = stx`
            <iq to="${this.get('jid')}" type="set" xmlns="jabber:client">
                <query xmlns="${Strophe.NS.MUC_OWNER}">
                    <x xmlns="${Strophe.NS.XFORM}" type="submit">
                        ${config.map((el) => Strophe.Builder.fromString(el.outerHTML))}
                    </x>
                </query>
            </iq>`;
        return api.sendIQ(iq);
    }

    onCommandError(err) {
        const { __ } = _converse;
        log.fatal(err);
        const message =
            __('Sorry, an error happened while running the command.') +
            ' ' +
            __("Check your browser's developer console for details.");
        this.createMessage({ message, 'type': 'error' });
    }

    getNickOrJIDFromCommandArgs(args) {
        const { __ } = _converse;
        if (u.isValidJID(args.trim())) {
            return args.trim();
        }
        if (!args.startsWith('@')) {
            args = '@' + args;
        }
        const result = this.parseTextForReferences(args);
        const references = result[1];
        if (!references.length) {
            const message = __("Error: couldn't find a groupchat participant based on your arguments");
            this.createMessage({ message, 'type': 'error' });
            return;
        }
        if (references.length > 1) {
            const message = __('Error: found multiple groupchat participant based on your arguments');
            this.createMessage({ message, 'type': 'error' });
            return;
        }
        const nick_or_jid = references.pop().value;
        const reason = args.split(nick_or_jid, 2)[1];
        if (reason && !reason.startsWith(' ')) {
            const message = __("Error: couldn't find a groupchat participant based on your arguments");
            this.createMessage({ message, 'type': 'error' });
            return;
        }
        return nick_or_jid;
    }

    validateRoleOrAffiliationChangeArgs(command, args) {
        const { __ } = _converse;
        if (!args) {
            const message = __(
                'Error: the "%1$s" command takes two arguments, the user\'s nickname and optionally a reason.',
                command
            );
            this.createMessage({ message, 'type': 'error' });
            return false;
        }
        return true;
    }

    getAllowedCommands() {
        let allowed_commands = ['clear', 'help', 'me', 'nick', 'register'];
        if (this.config.get('changesubject') || ['owner', 'admin'].includes(this.getOwnAffiliation())) {
            allowed_commands = [...allowed_commands, ...['subject', 'topic']];
        }
        const bare_jid = _converse.session.get('bare_jid');
        const occupant = this.occupants.findWhere({ 'jid': bare_jid });
        if (this.verifyAffiliations(['owner'], occupant, false)) {
            allowed_commands = allowed_commands.concat(OWNER_COMMANDS).concat(ADMIN_COMMANDS);
        } else if (this.verifyAffiliations(['admin'], occupant, false)) {
            allowed_commands = allowed_commands.concat(ADMIN_COMMANDS);
        }
        if (this.verifyRoles(['moderator'], occupant, false)) {
            allowed_commands = allowed_commands.concat(MODERATOR_COMMANDS).concat(VISITOR_COMMANDS);
        } else if (!this.verifyRoles(['visitor', 'participant', 'moderator'], occupant, false)) {
            allowed_commands = allowed_commands.concat(VISITOR_COMMANDS);
        }
        allowed_commands.sort();

        if (Array.isArray(api.settings.get('muc_disable_slash_commands'))) {
            return allowed_commands.filter((c) => !api.settings.get('muc_disable_slash_commands').includes(c));
        } else {
            return allowed_commands;
        }
    }

    verifyAffiliations(affiliations, occupant, show_error = true) {
        const { __ } = _converse;
        if (!Array.isArray(affiliations)) {
            throw new TypeError('affiliations must be an Array');
        }
        if (!affiliations.length) {
            return true;
        }
        const bare_jid = _converse.session.get('bare_jid');
        occupant = occupant || this.occupants.findWhere({ 'jid': bare_jid });
        if (occupant) {
            const a = occupant.get('affiliation');
            if (affiliations.includes(a)) {
                return true;
            }
        }
        if (show_error) {
            const message = __('Forbidden: you do not have the necessary affiliation in order to do that.');
            this.createMessage({ message, 'type': 'error' });
        }
        return false;
    }

    verifyRoles(roles, occupant, show_error = true) {
        const { __ } = _converse;
        if (!Array.isArray(roles)) {
            throw new TypeError('roles must be an Array');
        }
        if (!roles.length) {
            return true;
        }
        const bare_jid = _converse.session.get('bare_jid');
        occupant = occupant || this.occupants.findWhere({ 'jid': bare_jid });
        if (occupant) {
            const role = occupant.get('role');
            if (roles.includes(role)) {
                return true;
            }
        }
        if (show_error) {
            const message = __('Forbidden: you do not have the necessary role in order to do that.');
            this.createMessage({ message, 'type': 'error', 'is_ephemeral': 20000 });
        }
        return false;
    }

    /**
     * Returns the `role` which the current user has in this MUC
     * @returns {('none'|'visitor'|'participant'|'moderator')}
     */
    getOwnRole() {
        return this.getOwnOccupant()?.get('role');
    }

    /**
     * Returns the `affiliation` which the current user has in this MUC
     * @returns {('none'|'outcast'|'member'|'admin'|'owner')}
     */
    getOwnAffiliation() {
        return this.getOwnOccupant()?.get('affiliation') || 'none';
    }

    /**
     * Get the {@link MUCOccupant} instance which
     * represents the current user.
     * @returns {MUCOccupant}
     */
    getOwnOccupant() {
        return this.occupants.getOwnOccupant();
    }

    /**
     * Send a presence stanza to update the user's nickname in this MUC.
     * @param {String} nick
     */
    async setNickname(nick) {
        const jid = Strophe.getBareJidFromJid(this.get('jid'));
        api.send(
            stx`<presence xmlns="jabber:client"
                    id="${getUniqueId()}"
                    from="${api.connection.get().jid}"
                    to="${jid}/${nick}"></presence>`
        );
    }

    /**
     * Send an IQ stanza to modify an occupant's role
     * @param {MUCOccupant} occupant
     * @param {string} role
     * @param {string} reason
     * @param {function} onSuccess - callback for a succesful response
     * @param {function} onError - callback for an error response
     */
    setRole(occupant, role, reason, onSuccess, onError) {
        const iq = stx`
            <iq to="${this.get('jid')}" type="set" xmlns="jabber:client">
                <query xmlns="${Strophe.NS.MUC_ADMIN}">
                    <item nick="${occupant.get('nick')}" role="${role}">
                        ${reason !== null ? stx`<reason>${reason}</reason>` : ''}
                    </item>
                </query>
            </iq>`;
        return api.sendIQ(iq).then(onSuccess).catch(onError);
    }

    /**
     * @param {string} nickname_or_jid - The nickname or JID of the occupant to be returned
     * @returns {MUCOccupant}
     */
    getOccupant(nickname_or_jid) {
        return u.isValidJID(nickname_or_jid)
            ? this.getOccupantByJID(nickname_or_jid)
            : this.getOccupantByNickname(nickname_or_jid);
    }

    /**
     * Return an array of occupant models that have the required role
     * @param {string} role
     * @returns {{jid: string, nick: string, role: string}[]}
     */
    getOccupantsWithRole(role) {
        return this.getOccupantsSortedBy('nick')
            .filter((o) => o.get('role') === role)
            .map((item) => {
                return {
                    jid: /** @type {string} */ item.get('jid'),
                    nick: /** @type {string} */ item.get('nick'),
                    role: /** @type {string} */ item.get('role'),
                };
            });
    }

    /**
     * Return an array of occupant models that have the required affiliation
     * @param {string} affiliation
     * @returns {{jid: string, nick: string, affiliation: string}[]}
     */
    getOccupantsWithAffiliation(affiliation) {
        return this.getOccupantsSortedBy('nick')
            .filter((o) => o.get('affiliation') === affiliation)
            .map((item) => {
                return {
                    jid: /** @type {string} */ item.get('jid'),
                    nick: /** @type {string} */ item.get('nick'),
                    affiliation: /** @type {string} */ item.get('affiliation'),
                };
            });
    }

    /**
     * Return an array of occupant models, sorted according to the passed-in attribute.
     * @param {string} attr - The attribute to sort the returned array by
     * @returns {MUCOccupant[]}
     */
    getOccupantsSortedBy(attr) {
        return Array.from(this.occupants.models).sort((a, b) =>
            a.get(attr) < b.get(attr) ? -1 : a.get(attr) > b.get(attr) ? 1 : 0
        );
    }

    /**
     * Fetch the lists of users with the given affiliations.
     * Then compute the delta between those users and
     * the passed in members, and if it exists, send the delta
     * to the XMPP server to update the member list.
     * @param {object} members - Map of member jids and affiliations.
     * @returns {Promise}
     *  A promise which is resolved once the list has been
     *  updated or once it's been established there's no need
     *  to update the list.
     */
    async updateMemberLists(members) {
        const muc_jid = this.get('jid');
        /** @type {Array<NonOutcastAffiliation>} */
        const all_affiliations = ['member', 'admin', 'owner'];
        const aff_lists = await Promise.all(all_affiliations.map((a) => getAffiliationList(a, muc_jid)));

        const old_members = aff_lists.reduce(
            /**
             * @param {MemberListItem[]} acc
             * @param {MemberListItem[]|Error} val
             * @returns {MemberListItem[]}
             */
            (acc, val) => {
                if (val instanceof Error) {
                    log.error(val);
                    return acc;
                }
                return [...val, ...acc];
            },
            []
        );

        await setAffiliations(
            muc_jid,
            computeAffiliationsDelta(true, false, members, /** @type {MemberListItem[]} */ (old_members))
        );
        await this.occupants.fetchMembers();
    }

    /**
     * Triggers a hook which gives 3rd party plugins an opportunity to determine
     * the nickname to use.
     * @return {Promise<string>} A promise which resolves with the nickname
     */
    async getNicknameFromHook() {
        /**
         * *Hook* which allows plugins to determine which nickname to use for
         * the given MUC
         * @event _converse#getNicknameForMUC
         * @type {string} The nickname to use
         */
        return await api.hook('getNicknameForMUC', this, null);
    }

    /**
     * Given a nick name, save it to the model state, otherwise, look
     * for a server-side reserved nickname or default configured
     * nickname and if found, persist that to the model state.
     * @param {string} nick
     * @returns {Promise<string>} A promise which resolves with the nickname
     */
    async getAndPersistNickname(nick) {
        nick =
            nick ||
            this.get('nick') ||
            (await this.getReservedNick()) ||
            (await this.getNicknameFromHook()) ||
            _converse.exports.getDefaultMUCNickname();

        if (nick) safeSave(this, { nick }, { silent: true });
        return nick;
    }

    /**
     * Use service-discovery to ask the XMPP server whether
     * this user has a reserved nickname for this groupchat.
     * If so, we'll use that, otherwise we render the nickname form.
     * @returns {Promise<string>} A promise which resolves with the reserved nick or null
     */
    async getReservedNick() {
        const stanza = stx`
            <iq to="${this.get('jid')}" type="get" xmlns="jabber:client">
                <query xmlns="${Strophe.NS.DISCO_INFO}" node="x-roomuser-item"/>
            </iq>`;
        const result = await api.sendIQ(stanza, null, false);
        if (u.isErrorObject(result)) {
            throw result;
        }
        // Result might be undefined due to a timeout
        const identity_el = result?.querySelector('query[node="x-roomuser-item"] identity');
        return identity_el ? identity_el.getAttribute('name') : null;
    }

    /**
     * Send an IQ stanza to the MUC to register this user's nickname.
     * This sets the user's affiliation to 'member' (if they weren't affiliated
     * before) and reserves the nickname for this user, thereby preventing other
     * users from using it in this MUC.
     * See https://xmpp.org/extensions/xep-0045.html#register
     */
    async registerNickname() {
        const { __ } = _converse;
        const nick = this.get('nick');
        const jid = this.get('jid');
        let iq, err_msg;
        try {
            iq = await api.sendIQ(
                stx`<iq to="${jid}" type="get" xmlns="jabber:client">
                    <query xmlns="${Strophe.NS.MUC_REGISTER}"/>
                </iq>`
            );
        } catch (e) {
            if (sizzle(`not-allowed[xmlns="${Strophe.NS.STANZAS}"]`, e).length) {
                err_msg = __("You're not allowed to register yourself in this groupchat.");
            } else if (sizzle(`registration-required[xmlns="${Strophe.NS.STANZAS}"]`, e).length) {
                err_msg = __("You're not allowed to register in this groupchat because it's members-only.");
            }
            log.error(e);
            return err_msg;
        }
        const required_fields = sizzle('field required', iq).map((f) => f.parentElement);
        if (required_fields.length > 1 && required_fields[0].getAttribute('var') !== 'muc#register_roomnick') {
            return log.error(`Can't register the user register in the groupchat ${jid} due to the required fields`);
        }
        try {
            await api.sendIQ(
                stx`<iq to="${jid}" type="set" xmlns="jabber:client">
                    <query xmlns="${Strophe.NS.MUC_REGISTER}">
                        <x xmlns="${Strophe.NS.XFORM}" type="submit">
                            <field var="FORM_TYPE">
                                <value>http://jabber.org/protocol/muc#register</value>
                            </field>
                            <field var="muc#register_roomnick">
                                <value>${nick}</value>
                            </field>
                        </x>
                    </query>
                </iq>`
            );
        } catch (e) {
            const err = await parseErrorStanza(e);
            if (err?.name === 'service-unavailable') {
                log.error("Can't register your nickname in this groupchat, it doesn't support registration.");
            } else if (err?.name === 'bad-request') {
                log.error("Can't register your nickname in this groupchat, invalid data form supplied.");
            } else {
                log.error(e);
            }
            throw err;
        }
    }

    /**
     * Check whether we should unregister the user from this MUC, and if so,
     * call {@link MUC#sendUnregistrationIQ}
     */
    async unregisterNickname() {
        if (api.settings.get('auto_register_muc_nickname') === 'unregister') {
            try {
                if (await api.disco.supports(Strophe.NS.MUC_REGISTER, this.get('jid'))) {
                    await this.sendUnregistrationIQ();
                }
            } catch (e) {
                log.error(e);
            }
        }
    }

    /**
     * Send an IQ stanza to the MUC to unregister this user's nickname.
     * If the user had a 'member' affiliation, it'll be removed and their
     * nickname will no longer be reserved and can instead be used (and
     * registered) by other users.
     */
    sendUnregistrationIQ() {
        const iq = stx`
            <iq to="${this.get('jid')}" type="set" xmlns="jabber:client">
                <query xmlns="${Strophe.NS.MUC_REGISTER}">
                    <remove/>
                </query>
            </iq>`;
        return api.sendIQ(iq).catch((e) => log.error(e));
    }

    /**
     * Given a presence stanza, update the occupant model based on its contents.
     * @param {MUCPresenceAttributes} attrs - The presence stanza
     */
    updateOccupantsOnPresence(attrs) {
        if (attrs.type === 'error' || (!attrs.jid && !attrs.nick && !attrs.occupant_id)) {
            return true;
        }

        const occupant = this.occupants.findOccupant(attrs);
        // Destroy an unavailable occupant if this isn't a nick change operation and if they're not affiliated
        if (
            attrs.type === 'unavailable' &&
            occupant &&
            !attrs.codes.includes(converse.MUC_NICK_CHANGED_CODE) &&
            !['admin', 'owner', 'member'].includes(attrs['affiliation'])
        ) {
            // Before destroying we set the new attrs, so that we can show the disconnection message
            occupant.set({
                ...attrs,
                presence: 'offline',
            });
            occupant.destroy();
            return;
        }

        const presence = attrs.type !== 'unavailable' ? 'online' : 'offline';
        const jid = attrs.jid || '';
        const occupant_attrs = {
            ...attrs,
            presence,
            jid: Strophe.getBareJidFromJid(jid) || occupant?.attributes?.jid,
            resource: Strophe.getResourceFromJid(jid) || occupant?.attributes?.resource,
        };

        if (attrs.is_self) {
            let modified = false;
            if (attrs.codes.includes(converse.MUC_NICK_CHANGED_CODE)) {
                modified = true;
                this.set('nick', attrs.nick);
            }
            if (this.features.get(Strophe.NS.OCCUPANTID) && this.get('occupant-id') !== attrs.occupant_id) {
                modified = true;
                this.set('occupant_id', attrs.occupant_id);
            }
            modified && this.save();
        }

        if (occupant) {
            occupant.save(occupant_attrs);
        } else {
            this.occupants.create(occupant_attrs);
        }
    }

    /**
     * @param {MUCMessageAttributes} attrs
     */
    fetchFeaturesIfConfigurationChanged(attrs) {
        // 104: configuration change
        // 170: logging enabled
        // 171: logging disabled
        // 172: room no longer anonymous
        // 173: room now semi-anonymous
        // 174: room now fully anonymous
        const codes = ['104', '170', '171', '172', '173', '174'];
        if (attrs.codes.filter((code) => codes.includes(code)).length) {
            this.refreshDiscoInfo();
        }
    }

    /**
     * Given two JIDs, which can be either user JIDs or MUC occupant JIDs,
     * determine whether they belong to the same user.
     * @param {String} jid1
     * @param {String} jid2
     * @returns {Boolean}
     */
    isSameUser(jid1, jid2) {
        const bare_jid1 = Strophe.getBareJidFromJid(jid1);
        const bare_jid2 = Strophe.getBareJidFromJid(jid2);
        const resource1 = Strophe.getResourceFromJid(jid1);
        const resource2 = Strophe.getResourceFromJid(jid2);
        if (u.isSameBareJID(jid1, jid2)) {
            if (bare_jid1 === this.get('jid')) {
                // MUC JIDs
                return resource1 === resource2;
            } else {
                return true;
            }
        } else {
            const occupant1 =
                bare_jid1 === this.get('jid')
                    ? this.occupants.findOccupant({ 'nick': resource1 })
                    : this.occupants.findOccupant({ 'jid': bare_jid1 });

            const occupant2 =
                bare_jid2 === this.get('jid')
                    ? this.occupants.findOccupant({ 'nick': resource2 })
                    : this.occupants.findOccupant({ 'jid': bare_jid2 });
            return occupant1 === occupant2;
        }
    }

    async isSubjectHidden() {
        const jids = await api.user.settings.get('mucs_with_hidden_subject', []);
        return jids.includes(this.get('jid'));
    }

    async toggleSubjectHiddenState() {
        const muc_jid = this.get('jid');
        const jids = await api.user.settings.get('mucs_with_hidden_subject', []);
        if (jids.includes(this.get('jid'))) {
            api.user.settings.set(
                'mucs_with_hidden_subject',
                jids.filter((jid) => jid !== muc_jid)
            );
        } else {
            api.user.settings.set('mucs_with_hidden_subject', [...jids, muc_jid]);
        }
    }

    /**
     * Handle a possible subject change and return `true` if so.
     * @param {object} attrs - Attributes representing a received
     *  message, as returned by {@link parseMUCMessage}
     */
    async handleSubjectChange(attrs) {
        const __ = _converse.__;
        if (typeof attrs.subject === 'string' && !attrs.thread && !attrs.message) {
            // https://xmpp.org/extensions/xep-0045.html#subject-mod
            // -----------------------------------------------------
            // The subject is changed by sending a message of type "groupchat" to the <room@service>,
            // where the <message/> MUST contain a <subject/> element that specifies the new subject but
            // MUST NOT contain a <body/> element (or a <thread/> element).
            const subject = attrs.subject;
            const author = attrs.nick;
            safeSave(this, { 'subject': { author, 'text': attrs.subject || '' } });
            if (!attrs.is_delayed && author) {
                const message = subject ? __('Topic set by %1$s', author) : __('Topic cleared by %1$s', author);
                const prev_msg = this.messages.last();
                if (
                    prev_msg?.get('nick') !== attrs.nick ||
                    prev_msg?.get('type') !== 'info' ||
                    prev_msg?.get('message') !== message
                ) {
                    this.createMessage({ message, 'nick': attrs.nick, 'type': 'info', 'is_ephemeral': true });
                }
                if (await this.isSubjectHidden()) {
                    this.toggleSubjectHiddenState();
                }
            }
            return true;
        }
        return false;
    }

    /**
     * Set the subject for this {@link MUC}
     * @param {String} value
     */
    setSubject(value = '') {
        api.send(stx`
            <message to="${this.get('jid')}" type="groupchat" xmlns="jabber:client">
                <subject>${value}</subject>
            </message>`);
    }

    /**
     * Is this a chat state notification that can be ignored,
     * because it's old or because it's from us.
     * @param {Object} attrs - The message attributes
     */
    ignorableCSN(attrs) {
        return attrs.chat_state && !attrs.body && (attrs.is_delayed || this.isOwnMessage(attrs));
    }

    /**
     * Determines whether the message is from ourselves by checking
     * the `from` attribute. Doesn't check the `type` attribute.
     * @param {Object|Element|MUCMessage} msg
     * @returns {boolean}
     */
    isOwnMessage(msg) {
        let from;
        if (msg instanceof Element) {
            from = msg.getAttribute('from');
        } else if (msg instanceof _converse.exports.MUCMessage) {
            from = msg.get('from');
        } else {
            from = msg.from;
        }
        return Strophe.getResourceFromJid(from) == this.get('nick');
    }

    /**
     * @param {MUCMessage} message
     * @param {MUCMessageAttributes} attrs
     * @return {object}
     */
    getUpdatedMessageAttributes(message, attrs) {
        const new_attrs = {
            ...super.getUpdatedMessageAttributes(message, attrs),
            ...pick(attrs, ['from_muc', 'occupant_id']),
        };

        if (this.isOwnMessage(attrs)) {
            const stanza_id_keys = Object.keys(attrs).filter((k) => k.startsWith('stanza_id'));
            Object.assign(new_attrs, { ...pick(attrs, stanza_id_keys) }, { body: attrs.body });
            if (!message.get('received')) {
                new_attrs.received = new Date().toISOString();
            }
        }
        return new_attrs;
    }

    /**
     * Send a MUC-0410 MUC Self-Ping stanza to room to determine
     * whether we're still joined.
     * @returns {Promise<boolean>}
     */
    async isJoined() {
        if (!this.isEntered()) {
            log.info(`isJoined: not pinging MUC ${this.get('jid')} since we're not entered`);
            return false;
        }
        if (!api.connection.connected()) {
            await new Promise((resolve) => api.listen.once('reconnected', resolve));
        }
        return api.ping(`${this.get('jid')}/${this.get('nick')}`);
    }

    /**
     * Sends a status update presence (i.e. based on the `<show>` element)
     * @param {import("../status/types").presence_attrs} attrs
     * @param {Element[]|Builder[]|Element|Builder} [child_nodes]
     *  Nodes(s) to be added as child nodes of the `presence` XML element.
     */
    async sendStatusPresence(attrs, child_nodes) {
        if (this.session.get('connection_status') === ROOMSTATUS.ENTERED) {
            const presence = await _converse.state.profile.constructPresence(
                {
                    ...attrs,
                    to: `${this.get('jid')}/${this.get('nick')}`,
                },
                /** @type {Element[]|Builder[]} */ (child_nodes)?.map((c) => c?.tree() ?? c)
            );
            api.send(presence);
        }
    }

    /**
     * Check whether we're still joined and re-join if not
     */
    async rejoinIfNecessary() {
        if (this.isRAICandidate()) {
            log.debug(`rejoinIfNecessary: not rejoining hidden MUC "${this.get('jid')}" since we're using RAI`);
            return true;
        }

        if (!(await this.isJoined())) {
            this.rejoin();
            return true;
        }
    }

    /**
     * @param {object} attrs
     * @returns {Promise<boolean>}
     */
    async shouldShowErrorMessage(attrs) {
        if (attrs.error_type === 'Decryption') {
            if (attrs.error_message === 'Message key not found. The counter was repeated or the key was not filled.') {
                // OMEMO message which we already decrypted before
                return false;
            } else if (attrs.error_condition === 'not-encrypted-for-this-device') {
                return false;
            }
        } else if (attrs.error_condition === 'not-acceptable' && (await this.rejoinIfNecessary())) {
            return false;
        }
        return super.shouldShowErrorMessage(attrs);
    }

    /**
     * Looks whether we already have a moderation message for this
     * incoming message. If so, it's considered "dangling" because
     * it probably hasn't been applied to anything yet, given that
     * the relevant message is only coming in now.
     * @param {object} attrs - Attributes representing a received
     *  message, as returned by {@link parseMUCMessage}
     * @returns {MUCMessage}
     */
    findDanglingModeration(attrs) {
        if (!this.messages.length) {
            return null;
        }
        // Only look for dangling moderation if there are newer
        // messages than this one, since moderation come after.
        if (this.messages.last().get('time') > attrs.time) {
            // Search from latest backwards
            const messages = Array.from(this.messages.models);
            const stanza_id = attrs[`stanza_id ${this.get('jid')}`];
            if (!stanza_id) {
                return null;
            }
            messages.reverse();
            return messages.find(
                ({ attributes }) =>
                    attributes.moderated === 'retracted' &&
                    attributes.moderated_id === stanza_id &&
                    attributes.moderated_by
            );
        }
    }

    /**
     * Handles message moderation based on the passed in attributes.
     * @param {object} attrs - Attributes representing a received
     *  message, as returned by {@link parseMUCMessage}
     * @returns {Promise<boolean>} Returns `true` or `false` depending on
     *  whether a message was moderated or not.
     */
    async handleModeration(attrs) {
        const MODERATION_ATTRIBUTES = [
            'editable',
            'moderated',
            'moderated_by',
            'moderated_by_id',
            'moderated_id',
            'moderation_reason',
        ];
        if (attrs.moderated === 'retracted') {
            const query = {};
            const key = `stanza_id ${this.get('jid')}`;
            query[key] = attrs.moderated_id;
            const message = this.messages.findWhere(query);
            if (!message) {
                attrs['dangling_moderation'] = true;
                await this.createMessage(attrs);
                return true;
            }
            message.save(pick(attrs, MODERATION_ATTRIBUTES));
            return true;
        } else {
            // Check if we have dangling moderation message
            const message = this.findDanglingModeration(attrs);
            if (message) {
                const moderation_attrs = pick(message.attributes, MODERATION_ATTRIBUTES);
                const new_attrs = Object.assign({ dangling_moderation: false }, attrs, moderation_attrs);
                delete new_attrs['id']; // Delete id, otherwise a new cache entry gets created
                message.save(new_attrs);
                return true;
            }
        }
        return false;
    }

    getNotificationsText() {
        const { __ } = _converse;
        const actors_per_state = this.notifications.toJSON();

        const role_changes = api.settings
            .get('muc_show_info_messages')
            .filter((role_change) => converse.MUC_ROLE_CHANGES_LIST.includes(role_change));

        const join_leave_events = api.settings
            .get('muc_show_info_messages')
            .filter((join_leave_event) => converse.MUC_TRAFFIC_STATES_LIST.includes(join_leave_event));

        const states = [...converse.CHAT_STATES, ...join_leave_events, ...role_changes];

        return states.reduce((result, state) => {
            const existing_actors = actors_per_state[state];
            if (!existing_actors?.length) {
                return result;
            }
            const actors = existing_actors.map((a) => this.getOccupant(a)?.getDisplayName() || a);
            if (actors.length === 1) {
                if (state === 'composing') {
                    return `${result}${__('%1$s is typing', actors[0])}\n`;
                } else if (state === 'paused') {
                    return `${result}${__('%1$s has stopped typing', actors[0])}\n`;
                } else if (state === GONE) {
                    return `${result}${__('%1$s has gone away', actors[0])}\n`;
                } else if (state === 'entered') {
                    return `${result}${__('%1$s has entered the groupchat', actors[0])}\n`;
                } else if (state === 'exited') {
                    return `${result}${__('%1$s has left the groupchat', actors[0])}\n`;
                } else if (state === 'op') {
                    return `${result}${__('%1$s is now a moderator', actors[0])}\n`;
                } else if (state === 'deop') {
                    return `${result}${__('%1$s is no longer a moderator', actors[0])}\n`;
                } else if (state === 'voice') {
                    return `${result}${__('%1$s has been given a voice', actors[0])}\n`;
                } else if (state === 'mute') {
                    return `${result}${__('%1$s has been muted', actors[0])}\n`;
                }
            } else if (actors.length > 1) {
                let actors_str;
                if (actors.length > 3) {
                    actors_str = `${Array.from(actors).slice(0, 2).join(', ')} and others`;
                } else {
                    const last_actor = actors.pop();
                    actors_str = __('%1$s and %2$s', actors.join(', '), last_actor);
                }

                if (state === 'composing') {
                    return `${result}${__('%1$s are typing', actors_str)}\n`;
                } else if (state === 'paused') {
                    return `${result}${__('%1$s have stopped typing', actors_str)}\n`;
                } else if (state === GONE) {
                    return `${result}${__('%1$s have gone away', actors_str)}\n`;
                } else if (state === 'entered') {
                    return `${result}${__('%1$s have entered the groupchat', actors_str)}\n`;
                } else if (state === 'exited') {
                    return `${result}${__('%1$s have left the groupchat', actors_str)}\n`;
                } else if (state === 'op') {
                    return `${result}${__('%1$s are now moderators', actors[0])}\n`;
                } else if (state === 'deop') {
                    return `${result}${__('%1$s are no longer moderators', actors[0])}\n`;
                } else if (state === 'voice') {
                    return `${result}${__('%1$s have been given voices', actors[0])}\n`;
                } else if (state === 'mute') {
                    return `${result}${__('%1$s have been muted', actors[0])}\n`;
                }
            }
            return result;
        }, '');
    }

    /**
     * @param { String } actor - The nickname of the actor that caused the notification
     * @param {String|Array<String>} states - The state or states representing the type of notificcation
     */
    removeNotification(actor, states) {
        const actors_per_state = this.notifications.toJSON();
        states = Array.isArray(states) ? states : [states];
        states.forEach((state) => {
            const existing_actors = Array.from(actors_per_state[state] || []);
            if (existing_actors.includes(actor)) {
                const idx = existing_actors.indexOf(actor);
                existing_actors.splice(idx, 1);
                this.notifications.set(state, Array.from(existing_actors));
            }
        });
    }

    /**
     * Update the notifications model by adding the passed in nickname
     * to the array of nicknames that all match a particular state.
     *
     * Removes the nickname from any other states it might be associated with.
     *
     * The state can be a XEP-0085 Chat State or a XEP-0045 join/leave state.
     * @param {String} actor - The nickname of the actor that causes the notification
     * @param {String} state - The state representing the type of notificcation
     */
    updateNotifications(actor, state) {
        const actors_per_state = this.notifications.toJSON();
        const existing_actors = actors_per_state[state] || [];
        if (existing_actors.includes(actor)) {
            return;
        }
        const reducer = (out, s) => {
            if (s === state) {
                out[s] = [...existing_actors, actor];
            } else {
                out[s] = (actors_per_state[s] || []).filter((a) => a !== actor);
            }
            return out;
        };
        const actors_per_chat_state = converse.CHAT_STATES.reduce(reducer, {});
        const actors_per_traffic_state = converse.MUC_TRAFFIC_STATES_LIST.reduce(reducer, {});
        const actors_per_role_change = converse.MUC_ROLE_CHANGES_LIST.reduce(reducer, {});
        this.notifications.set(Object.assign(actors_per_chat_state, actors_per_traffic_state, actors_per_role_change));
        setTimeout(() => this.removeNotification(actor, state), 10000);
    }

    /**
     * @param {MessageAttributes} attrs
     * @returns {boolean}
     */
    handleMUCPrivateMessage(attrs) {
        if (attrs.type === 'chat' || attrs.type === null) {
            const occupant = this.occupants.findOccupant(attrs);
            if (occupant) {
                return occupant.queueMessage(attrs);
            }
            // TODO create occupant?
        }
        return false;
    }

    /**
     * @param {MessageAttributes} attrs
     * @returns {boolean}
     */
    handleMetadataFastening(attrs) {
        if (attrs.ogp_for_id) {
            if (attrs.from !== this.get('jid')) {
                // For now we only allow metadata from the MUC itself and not
                // from individual users who are deemed less trustworthy.
                return false;
            }
            const message = this.messages.findWhere({ 'origin_id': attrs.ogp_for_id });
            if (message) {
                const old_list = message.get('ogp_metadata') || [];
                if (old_list.filter((m) => m['og:url'] === attrs['og:url']).length) {
                    // Don't add metadata for the same URL again
                    return false;
                }
                const list = [...old_list, pick(attrs, METADATA_ATTRIBUTES)];
                message.save('ogp_metadata', list);
                return true;
            }
        }
        return false;
    }

    /**
     * Given {@link MessageAttributes} look for XEP-0316 Room Notifications and create info
     * messages for them.
     * @param {MUCMessageAttributes} attrs
     * @returns {boolean}
     */
    handleMEPNotification(attrs) {
        if (attrs.from !== this.get('jid') || !attrs.activities) {
            return false;
        }
        attrs.activities?.forEach((activity_attrs) => {
            const data = Object.assign(attrs, activity_attrs);
            this.createMessage(data);
            // Trigger so that notifications are shown
            api.trigger('message', { 'attrs': data, 'chatbox': this });
        });
        return !!attrs.activities.length;
    }

    /**
     * Returns an already cached message (if it exists) based on the
     * passed in attributes map.
     * @param {object} attrs - Attributes representing a received
     *  message, as returned by {@link parseMUCMessage}
     * @returns {MUCMessage|BaseMessage}
     */
    getDuplicateMessage(attrs) {
        if (attrs.activities?.length) {
            return this.messages.findWhere({ type: 'mep', msgid: attrs.msgid });
        } else {
            return super.getDuplicateMessage(attrs);
        }
    }

    /**
     * Handler for all MUC messages sent to this groupchat. This method
     * shouldn't be called directly, instead {@link MUC#queueMessage}
     * should be called.
     * @param {MUCMessageAttributes|StanzaParseError} attrs_or_error - A promise which resolves to the message attributes.
     */
    async onMessage(attrs_or_error) {
        if (u.isErrorObject(attrs_or_error)) {
            return log.error(/** @type {Error} */ (attrs_or_error).message);
        }

        const attrs = /** @type {MUCMessageAttributes} */ (attrs_or_error);
        if (attrs.type === 'error' && !(await this.shouldShowErrorMessage(attrs))) {
            return;
        }

        const message = this.getDuplicateMessage(attrs);
        if (message) {
            message.get('type') === 'groupchat' && this.updateMessage(message, attrs);
            return;
        } else if (attrs.receipt_id || attrs.is_marker || this.ignorableCSN(attrs)) {
            return;
        }

        if (
            this.handleMUCPrivateMessage(attrs) ||
            this.handleMetadataFastening(attrs) ||
            this.handleMEPNotification(attrs) ||
            (await this.handleModeration(attrs)) ||
            (await this.handleRetraction(attrs)) ||
            (await this.handleSubjectChange(attrs))
        ) {
            attrs.nick && this.removeNotification(attrs.nick, ['composing', 'paused']);
            return;
        }

        this.setEditable(attrs, attrs.time);

        if (attrs['chat_state']) {
            this.updateNotifications(attrs.nick, attrs.chat_state);
        }
        if (shouldCreateGroupchatMessage(attrs)) {
            const msg = (await this.handleCorrection(attrs)) || (await this.createMessage(attrs));
            this.removeNotification(attrs.nick, ['composing', 'paused']);
            this.handleUnreadMessage(msg);
        }
    }

    /**
     * @param {Element} pres
     */
    handleModifyError(pres) {
        const text = pres.querySelector('error text')?.textContent;
        if (text) {
            if (this.session.get('connection_status') === ROOMSTATUS.CONNECTING) {
                this.setDisconnectionState(text);
            } else {
                const attrs = {
                    'type': 'error',
                    'message': text,
                    'is_ephemeral': true,
                };
                this.createMessage(attrs);
            }
        }
    }

    /**
     * Handle a presence stanza that disconnects the user from the MUC
     * @param {MUCPresenceAttributes} attrs - The stanza
     */
    handleDisconnection(attrs) {
        const { is_self, reason, actor } = attrs;
        const codes = attrs.codes.filter((c) => DISCONNECT_CODES.includes(c));
        const disconnected = is_self && codes.length > 0;
        if (!disconnected) {
            return;
        }
        const { STATUS_CODE_MESSAGES } = /** @type {UserMessage} */ (_converse.labels.muc);
        const message = STATUS_CODE_MESSAGES[codes[0]];
        const status = codes.includes('301') ? ROOMSTATUS.BANNED : ROOMSTATUS.DISCONNECTED;
        this.setDisconnectionState(message, reason, actor?.nick, status);
    }

    /**
     * @param {import('./types').MUCStatusCode} code
     * @param {MUCPresenceAttributes} attrs
     */
    getActionInfoMessage(code, attrs) {
        const { nick, actor } = attrs;
        const __ = _converse.__;
        if (code === '301') {
            return actor?.nick
                ? __('%1$s has been banned by %2$s', nick, actor.nick)
                : __('%1$s has been banned', nick);
        } else if (code === '303') {
            return __("%1$s's nickname has changed", nick);
        } else if (code === '307') {
            return actor?.nick
                ? __('%1$s has been kicked out by %2$s', nick, actor.nick)
                : __('%1$s has been kicked out', nick);
        } else if (code === '321') {
            return __('%1$s has been removed because of an affiliation change', nick);
        } else if (code === '322') {
            return __('%1$s has been removed for not being a member', nick);
        }
    }

    /**
     * @param {MUCOccupant} occupant
     */
    createAffiliationChangeMessage(occupant) {
        const __ = _converse.__;
        const previous_affiliation = occupant._previousAttributes.affiliation;

        if (!previous_affiliation) {
            // If no previous affiliation was set, then we don't
            // interpret this as an affiliation change.
            // For example, if muc_send_probes is true, then occupants
            // are created based on incoming messages, in which case
            // we don't yet know the affiliation
            return;
        }

        const current_affiliation = occupant.get('affiliation');
        if (previous_affiliation === 'admin' && isInfoVisible(converse.AFFILIATION_CHANGES.EXADMIN)) {
            this.createMessage({
                type: 'info',
                message: __('%1$s is no longer an admin of this groupchat', occupant.get('nick')),
            });
        } else if (previous_affiliation === 'owner' && isInfoVisible(converse.AFFILIATION_CHANGES.EXOWNER)) {
            this.createMessage({
                type: 'info',
                message: __('%1$s is no longer an owner of this groupchat', occupant.get('nick')),
            });
        } else if (previous_affiliation === 'outcast' && isInfoVisible(converse.AFFILIATION_CHANGES.EXOUTCAST)) {
            this.createMessage({
                type: 'info',
                message: __('%1$s is no longer banned from this groupchat', occupant.get('nick')),
            });
        }

        if (
            current_affiliation === 'none' &&
            previous_affiliation === 'member' &&
            isInfoVisible(converse.AFFILIATION_CHANGES.EXMEMBER)
        ) {
            this.createMessage({
                type: 'info',
                message: __('%1$s is no longer a member of this groupchat', occupant.get('nick')),
            });
        }

        if (current_affiliation === 'member' && isInfoVisible(converse.AFFILIATION_CHANGES.MEMBER)) {
            this.createMessage({
                type: 'info',
                message: __('%1$s is now a member of this groupchat', occupant.get('nick')),
            });
        } else if (
            (current_affiliation === 'admin' && isInfoVisible(converse.AFFILIATION_CHANGES.ADMIN)) ||
            (current_affiliation == 'owner' && isInfoVisible(converse.AFFILIATION_CHANGES.OWNER))
        ) {
            // For example: AppleJack is now an (admin|owner) of this groupchat
            this.createMessage({
                type: 'info',
                message: __('%1$s is now an %2$s of this groupchat', occupant.get('nick'), current_affiliation),
            });
        }
    }

    createRoleChangeMessage(occupant, changed) {
        if (changed === 'none' || occupant.changed.affiliation) {
            // We don't inform of role changes if they accompany affiliation changes.
            return;
        }
        const previous_role = occupant._previousAttributes.role;
        if (previous_role === 'moderator' && isInfoVisible(converse.MUC_ROLE_CHANGES.DEOP)) {
            this.updateNotifications(occupant.get('nick'), converse.MUC_ROLE_CHANGES.DEOP);
        } else if (previous_role === 'visitor' && isInfoVisible(converse.MUC_ROLE_CHANGES.VOICE)) {
            this.updateNotifications(occupant.get('nick'), converse.MUC_ROLE_CHANGES.VOICE);
        }
        if (occupant.get('role') === 'visitor' && isInfoVisible(converse.MUC_ROLE_CHANGES.MUTE)) {
            this.updateNotifications(occupant.get('nick'), converse.MUC_ROLE_CHANGES.MUTE);
        } else if (occupant.get('role') === 'moderator') {
            if (
                !['owner', 'admin'].includes(occupant.get('affiliation')) &&
                isInfoVisible(converse.MUC_ROLE_CHANGES.OP)
            ) {
                // Oly show this message if the user isn't already
                // an admin or owner, otherwise this isn't new information.
                this.updateNotifications(occupant.get('nick'), converse.MUC_ROLE_CHANGES.OP);
            }
        }
    }

    /**
     * Create an info message based on a received MUC status code in a
     * <presence> stanza.
     * @param {import('./types').MUCStatusCode} code
     * @param {MUCPresenceAttributes} attrs - The original stanza
     */
    createInfoMessageFromPresence(code, attrs) {
        const __ = _converse.__;
        const is_self = /** @type {MUCPresenceAttributes} */ (attrs).is_self ?? false;

        if (!isInfoVisible || code === '110' || (code === '100' && !is_self)) {
            return;
        }

        const { STATUS_CODE_MESSAGES } = /** @type {UserMessage} */ (_converse.labels.muc);
        const message = STATUS_CODE_MESSAGES[code];
        const data = {
            type: 'info',
            is_ephemeral: true,
            message,
            code,
        };

        if (!is_self && ACTION_INFO_CODES.includes(code)) {
            data.message = this.getActionInfoMessage(code, attrs);
            data.reason = attrs.reason;
        } else if (is_self && NEW_NICK_CODES.includes(code)) {
            data.message = attrs.nick ? __(message, attrs.nick) : undefined;
        }

        if (data.message) {
            if (code === '201' && this.messages.findWhere(data)) {
                return;
            }
            this.createMessage(data);
        }
    }

    /**
     * Create an info message based on a received MUC status code in a <message> stanza.
     * @param {import('./types').MUCStatusCode} code
     */
    createInfoMessage(code) {
        if (!isInfoVisible(code) || code === '110') {
            return;
        }

        const { STATUS_CODE_MESSAGES } = /** @type {UserMessage} */ (_converse.labels.muc);
        const message = STATUS_CODE_MESSAGES[code];

        if (message) {
            this.createMessage({
                type: 'info',
                is_ephemeral: true,
                message,
                code,
            });
        }
    }

    /**
     * Set parameters regarding disconnection from this room. This helps to
     * communicate to the user why they were disconnected.
     * @param {string} message - The disconnection message, as received from (or
     *  implied by) the server.
     * @param {string} [reason] - The reason provided for the disconnection
     * @param {string} [actor] - The person (if any) responsible for this disconnection
     * @param {number} [status] - The status code (see `ROOMSTATUS`)
     */
    setDisconnectionState(message, reason, actor, status = ROOMSTATUS.DISCONNECTED) {
        this.session.save({
            'connection_status': status,
            'disconnection_actor': actor,
            'disconnection_message': message,
            'disconnection_reason': reason,
        });
    }

    /**
     * @param {Element} presence
     */
    onNicknameClash(presence) {
        const __ = _converse.__;
        if (api.settings.get('muc_nickname_from_jid')) {
            const nick = presence.getAttribute('from').split('/')[1];
            if (nick === _converse.exports.getDefaultMUCNickname()) {
                this.join(nick + '-2');
            } else {
                const del = nick.lastIndexOf('-');
                const num = nick.substring(del + 1, nick.length);
                this.join(nick.substring(0, del + 1) + String(Number(num) + 1));
            }
        } else {
            this.save({
                'nickname_validation_message': __(
                    'The nickname you chose is reserved or ' + 'currently in use, please choose a different one.'
                ),
            });
            this.session.save({ 'connection_status': ROOMSTATUS.NICKNAME_REQUIRED });
        }
    }

    /**
     * Parses a <presence> stanza with type "error" and sets the proper
     * `connection_status` value for this {@link MUC} as
     * well as any additional output that can be shown to the user.
     * @param {Element} stanza - The presence stanza
     */
    onErrorPresence(stanza) {
        const __ = _converse.__;
        const error = stanza.querySelector('error');
        const error_type = error.getAttribute('type');
        const reason = sizzle(`text[xmlns="${Strophe.NS.STANZAS}"]`, error).pop()?.textContent;

        if (error_type === 'modify') {
            this.handleModifyError(stanza);
        } else if (error_type === 'auth') {
            if (sizzle(`not-authorized[xmlns="${Strophe.NS.STANZAS}"]`, error).length) {
                this.save({ 'password_validation_message': reason || __('Password incorrect') });
                this.session.save({ 'connection_status': ROOMSTATUS.PASSWORD_REQUIRED });
            }
            if (error.querySelector('registration-required')) {
                const message = __('You are not on the member list of this groupchat.');
                this.setDisconnectionState(message, reason);
            } else if (error.querySelector('forbidden')) {
                const { STATUS_CODE_MESSAGES } = /** @type {UserMessage} */ (_converse.labels.muc);
                this.setDisconnectionState(STATUS_CODE_MESSAGES[301], reason, null, ROOMSTATUS.BANNED);
            }
        } else if (error_type === 'cancel') {
            if (error.querySelector('not-allowed')) {
                const message = __('You are not allowed to create new groupchats.');
                this.setDisconnectionState(message, reason);
            } else if (error.querySelector('not-acceptable')) {
                const message = __("Your nickname doesn't conform to this groupchat's policies.");
                this.setDisconnectionState(message, reason);
            } else if (sizzle(`gone[xmlns="${Strophe.NS.STANZAS}"]`, error).length) {
                const moved_jid = sizzle(`gone[xmlns="${Strophe.NS.STANZAS}"]`, error)
                    .pop()
                    ?.textContent.replace(/^xmpp:/, '')
                    .replace(/\?join$/, '');
                this.save({ moved_jid, 'destroyed_reason': reason });
                this.session.save({ 'connection_status': ROOMSTATUS.DESTROYED });
            } else if (error.querySelector('conflict')) {
                this.onNicknameClash(stanza);
            } else if (error.querySelector('item-not-found')) {
                const message = __('This groupchat does not (yet) exist.');
                this.setDisconnectionState(message, reason);
            } else if (error.querySelector('service-unavailable')) {
                const message = __('This groupchat has reached its maximum number of participants.');
                this.setDisconnectionState(message, reason);
            } else if (error.querySelector('remote-server-not-found')) {
                const message = __('Remote server not found');
                this.setDisconnectionState(message, reason);
            } else if (error.querySelector('forbidden')) {
                const message = __("You're not allowed to enter this groupchat");
                this.setDisconnectionState(message, reason);
            } else {
                const message = __('An error happened while trying to enter this groupchat');
                this.setDisconnectionState(message, reason);
            }
        }
    }

    /**
     * Listens for incoming presence stanzas from the service that hosts this MUC
     * @param {Element} stanza - The presence stanza
     */
    onPresenceFromMUCHost(stanza) {
        if (stanza.getAttribute('type') === 'error') {
            const error = stanza.querySelector('error');
            if (error?.getAttribute('type') === 'wait' && error?.querySelector('resource-constraint')) {
                // If we get a <resource-constraint> error, we assume it's in context of XEP-0437 RAI.
                // We remove this MUC's host from the list of enabled domains and rejoin the MUC.
                if (this.session.get('connection_status') === ROOMSTATUS.DISCONNECTED) {
                    this.rejoin();
                }
            }
        }
    }

    /**
     * Handles incoming presence stanzas coming from the MUC
     * @param {Element} stanza
     */
    async onPresence(stanza) {
        if (stanza.getAttribute('type') === 'error') {
            return this.onErrorPresence(stanza);
        }

        const attrs = await parseMUCPresence(stanza, this);
        attrs.codes.forEach(async (code) => {
            this.createInfoMessageFromPresence(code, attrs);

            if (attrs.is_self && NEW_NICK_CODES.includes(code)) {
                this.save('nick', attrs.nick);

                if (
                    code === '303' &&
                    api.settings.get('auto_register_muc_nickname') &&
                    (await api.disco.supports(Strophe.NS.MUC_REGISTER, this.get('jid')))
                ) {
                    try {
                        await this.registerNickname();
                    } catch (e) {
                        log.error(e);
                        log.error('Error: could not register new nickname');
                    }
                }
            }
        });

        if (attrs.is_self) {
            this.onOwnPresence(attrs);
            if (this.getOwnRole() !== 'none' && this.session.get('connection_status') === ROOMSTATUS.CONNECTING) {
                this.session.save('connection_status', ROOMSTATUS.CONNECTED);
            }
        } else {
            this.updateOccupantsOnPresence(attrs);
        }
    }

    /**
     * Handles a received presence relating to the current user.
     *
     * For locked groupchats (which are by definition "new"), the
     * groupchat will either be auto-configured or created instantly
     * (with default config) or a configuration groupchat will be
     * rendered.
     *
     * If the groupchat is not locked, then the groupchat will be
     * auto-configured only if applicable and if the current
     * user is the groupchat's owner.
     * @param {MUCPresenceAttributes} attrs
     */
    async onOwnPresence(attrs) {
        await this.occupants.fetched;

        if (attrs['type'] === 'unavailable') {
            this.handleDisconnection(attrs);
            return;
        }

        const old_status = this.session.get('connection_status');
        if (old_status !== ROOMSTATUS.ENTERED && old_status !== ROOMSTATUS.CLOSING) {
            // Set connection_status before creating the occupant, but
            // only trigger afterwards, so that plugins can access the
            // occupant in their event handlers.
            this.session.save('connection_status', ROOMSTATUS.ENTERED, { 'silent': true });
            this.updateOccupantsOnPresence(attrs);
            this.session.trigger('change:connection_status', this.session, old_status);
        } else {
            this.updateOccupantsOnPresence(attrs);
        }

        const locked_room = attrs.codes.includes('201');
        if (locked_room) {
            if (this.get('auto_configure')) {
                await this.autoConfigureChatRoom().then(() => this.refreshDiscoInfo());
            } else if (api.settings.get('muc_instant_rooms')) {
                // Accept default configuration
                await this.sendConfiguration().then(() => this.refreshDiscoInfo());
            } else {
                api.modal.show('converse-muc-config-modal', { model: this });
            }
        }
    }

    /**
     * Returns a boolean to indicate whether the current user
     * was mentioned in a message.
     * @param {BaseMessage} message - The text message
     */
    isUserMentioned(message) {
        const nick = this.get('nick');
        if (message.get('references').length) {
            const mentions = message
                .get('references')
                .filter((ref) => ref.type === 'mention')
                .map((ref) => ref.value);
            return mentions.includes(nick);
        } else {
            return new RegExp(`\\b${nick}\\b`).test(message.get('body'));
        }
    }

    /**
     * @param {BaseMessage} message - The text message
     */
    incrementUnreadMsgsCounter(message) {
        const settings = {
            'num_unread_general': this.get('num_unread_general') + 1,
        };
        if (this.get('num_unread_general') === 0) {
            settings['first_unread_id'] = message.get('id');
        }
        if (this.isUserMentioned(message)) {
            settings.num_unread = this.get('num_unread') + 1;
        }
        this.save(settings);
    }

    async clearUnreadMsgCounter() {
        if (this.get('num_unread_general') > 0 || this.get('num_unread') > 0 || this.get('has_activity')) {
            await this.sendMarkerForMessage(this.messages.last());
        }
        safeSave(this, {
            'has_activity': false,
            'num_unread': 0,
            'num_unread_general': 0,
        });
    }
}

export default MUC;
