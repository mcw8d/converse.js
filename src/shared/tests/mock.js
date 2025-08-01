let _converse;
const mock = {};
const converse = window.converse;
converse.load();
const { u, sizzle, Strophe, dayjs, $iq, $msg, $pres } = converse.env;


jasmine.DEFAULT_TIMEOUT_INTERVAL = 7000;

jasmine.toEqualStanza = function toEqualStanza () {
    return {
        compare (actual, expected) {
            const result = { pass: u.isEqualNode(actual, expected) };
            if (!result.pass) {
                result.message = `Stanzas don't match:\n`+
                    `Actual:\n${(actual.tree?.() ?? actual).outerHTML}\n`+
                    `Expected:\n${expected.tree().outerHTML}`;
            }
            return result;
        }
    }
}

function initConverse (promise_names=[], settings=null, func) {
    if (typeof promise_names === "function") {
        func = promise_names;
        promise_names = []
        settings = null;
    }

    return async () => {
        if (_converse && _converse.api.connection.connected()) {
            await _converse.api.user.logout();
        }
        const el = document.querySelector('#conversejs');
        if (el) {
            el.parentElement.removeChild(el);
        }
        document.title = "Converse Tests";

        await _initConverse(settings);
        await Promise.all((promise_names || []).map(_converse.api.waitUntil));

        // eslint-disable-next-line max-len
        _converse.default_avatar_image = 'PD94bWwgdmVyc2lvbj0iMS4wIj8+CjxzdmcgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCI+CiA8cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgZmlsbD0iIzU1NSIvPgogPGNpcmNsZSBjeD0iNjQiIGN5PSI0MSIgcj0iMjQiIGZpbGw9IiNmZmYiLz4KIDxwYXRoIGQ9Im0yOC41IDExMiB2LTEyIGMwLTEyIDEwLTI0IDI0LTI0IGgyMyBjMTQgMCAyNCAxMiAyNCAyNCB2MTIiIGZpbGw9IiNmZmYiLz4KPC9zdmc+Cg==';
        _converse.default_avatar_image_type = 'image/svg+xml';

        try {
            await func(_converse);
        } catch(e) {
            console.error(e);
            fail(e);
        }
    }
}

function getContactJID(index) {
    return mock.cur_names[index].replace(/ /g,'.').toLowerCase() + '@montague.lit';
}

async function checkHeaderToggling(group) {
    const toggle = group.querySelector('a.group-toggle');
    expect(u.isVisible(group)).toBeTruthy();
    expect(group.querySelectorAll('ul.collapsed').length).toBe(0);
    expect(u.hasClass('fa-caret-right', toggle.firstElementChild)).toBeFalsy();
    expect(u.hasClass('fa-caret-down', toggle.firstElementChild)).toBeTruthy();
    toggle.click();

    await u.waitUntil(() => group.querySelectorAll('ul.collapsed').length === 1);
    expect(u.hasClass('fa-caret-right', toggle.firstElementChild)).toBeTruthy();
    expect(u.hasClass('fa-caret-down', toggle.firstElementChild)).toBeFalsy();
    toggle.click();
    await u.waitUntil(() => group.querySelectorAll('li .open-chat').length ===
        Array.from(group.querySelectorAll('li .open-chat')).filter(u.isVisible).length);

    expect(u.hasClass('fa-caret-right', toggle.firstElementChild)).toBeFalsy();
    expect(u.hasClass('fa-caret-down', toggle.firstElementChild)).toBeTruthy();
};

async function waitUntilDiscoConfirmed (_converse, entity_jid, identities, features=[], items=[], type='info') {
    const sel = `iq[to="${entity_jid}"] query[xmlns="http://jabber.org/protocol/disco#${type}"]`;
    const iq = await u.waitUntil(() => _converse.api.connection.get().IQ_stanzas.find(iq => sizzle(sel, iq).length));
    const stanza = stx`
            <iq type="result"
                from="${entity_jid}"
                to="${_converse.session.get('jid')}"
                id="${iq.getAttribute('id')}"
                xmlns="jabber:client">
            <query xmlns="http://jabber.org/protocol/disco#${type}">
                ${identities?.map(identity => stx`<identity category="${identity.category}" type="${identity.type}"></identity>`)}
                ${features?.map(feature => stx`<feature var="${feature}"></feature>`)}
                ${items?.map(item => stx`<item jid="${item}"></item>`)}
            </query>
            </iq>`;
    _converse.api.connection.get()._dataRecv(createRequest(stanza));
}

function createRequest (stanza) {
    stanza = typeof stanza.tree == "function" ? stanza.tree() : stanza;
    const req = new Strophe.Request(stanza, () => {});
    req.getResponse = function () {
        var env = new Strophe.Builder('env', {type: 'mock'}).tree();
        env.appendChild(stanza);
        return env;
    };
    return req;
}

function closeAllChatBoxes (_converse) {
    return Promise.all(_converse.chatboxviews.map(view => view.close()));
}

function toggleControlBox () {
    const toggle = document.querySelector(".toggle-controlbox");
    if (!u.isVisible(document.querySelector("#controlbox"))) {
        if (!u.isVisible(toggle)) {
            u.removeClass('hidden', toggle);
        }
        toggle.click();
    }
}

async function openControlBox(_converse) {
    const model = await _converse.api.controlbox.open();
    await u.waitUntil(() => model.get('connected'));
    toggleControlBox();
    return model;
}

function closeControlBox () {
    const view = document.querySelector("#controlbox");
    u.isVisible(view) && view.querySelector(".controlbox-heading__btn.close")?.click();
}

async function waitUntilBlocklistInitialized (_converse, blocklist=[]) {
    window.sessionStorage.removeItem('converse.blocklist-romeo@montague.lit-fetched');

    const { api } = _converse;
    await mock.waitUntilDiscoConfirmed(
        _converse,
        _converse.domain,
        [{ 'category': 'server', 'type': 'IM' }],
        ['urn:xmpp:blocking']
    );
    const connection = api.connection.get();
    const IQ_stanzas = connection.IQ_stanzas;
    const sent_stanza = await u.waitUntil(() => IQ_stanzas.find((s) => s.querySelector('iq blocklist')));

    connection._dataRecv(mock.createRequest(stx`
            <iq xmlns="jabber:client"
                to="${connection.jid}"
                type="result"
                id="${sent_stanza.getAttribute('id')}">
            <blocklist xmlns='urn:xmpp:blocking'>
                ${blocklist.map((jid) => stx`<item jid='${jid}'/>`)}
            </blocklist>
        </iq>`));

    return await api.waitUntil('blocklistInitialized');
}

async function waitUntilBookmarksReturned (
    _converse,
    bookmarks=[],
    features=[
        'http://jabber.org/protocol/pubsub#publish-options',
        'http://jabber.org/protocol/pubsub#config-node-max',
        'urn:xmpp:bookmarks:1#compat'
   ],
    node='urn:xmpp:bookmarks:1'
) {
    await waitUntilDiscoConfirmed(
        _converse, _converse.bare_jid,
        [{'category': 'pubsub', 'type': 'pep'}],
        features,
    );
    const IQ_stanzas = _converse.api.connection.get().IQ_stanzas;
    const sent_stanza = await u.waitUntil(
        () => IQ_stanzas.filter(s => sizzle(`items[node="${node}"]`, s).length).pop()
    );

    let stanza;
    if (node === 'storage:bookmarks') {
        stanza = stx`
            <iq to="${_converse.api.connection.get().jid}"
                type="result"
                id="${sent_stanza.getAttribute('id')}"
                xmlns="jabber:client">
            <pubsub xmlns="${Strophe.NS.PUBSUB}">
                <items node="storage:bookmarks">
                    <item id="current">
                        <storage xmlns="storage:bookmarks">
                        </storage>
                    </item>
                    ${bookmarks.map((b) => stx`
                        <conference name="${b.name}" autojoin="${b.autojoin}" jid="${b.jid}">
                            ${b.nick ? stx`<nick>${b.nick}</nick>` : ''}
                        </conference>`)}
                </items>
            </pubsub>
            </iq>`;
    } else {
        stanza = stx`
            <iq type="result"
                to="${_converse.jid}"
                id="${sent_stanza.getAttribute('id')}"
                xmlns="jabber:client">
            <pubsub xmlns="${Strophe.NS.PUBSUB}">
                <items node="urn:xmpp:bookmarks:1">
                ${bookmarks.map((b) => stx`
                    <item id="${b.jid}">
                        <conference xmlns="urn:xmpp:bookmarks:1"
                                    name="${b.name}"
                                    autojoin="${b.autojoin ?? false}">
                            ${b.nick ? stx`<nick>${b.nick}</nick>` : ''}
                            ${b.password ? stx`<password>${b.password}</password>` : ''}
                        </conference>
                    </item>`)
                };
                </items>
            </pubsub>
            </iq>`;
    }

    _converse.api.connection.get()._dataRecv(createRequest(stanza));
    await _converse.api.waitUntil('bookmarksInitialized');
}

function openChatBoxes (converse, amount) {
    for (let i=0; i<amount; i++) {
        const jid = cur_names[i].replace(/ /g,'.').toLowerCase() + '@montague.lit';
        converse.roster.get(jid).openChat();
    }
}

async function openChatBoxFor (_converse, jid) {
    await _converse.api.waitUntil('rosterContactsFetched');
    _converse.roster.get(jid).openChat();
    return u.waitUntil(() => _converse.chatboxviews.get(jid), 1000);
}

/**
 * Returns an item-not-found disco info result, simulating that this was a
 * new MUC being entered.
 */
async function waitForNewMUCDiscoInfo(_converse, muc_jid) {
    const { api } = _converse;
    const connection = api.connection.get();
    const own_jid = connection.jid;
    const stanzas = connection.IQ_stanzas;
    const stanza = await u.waitUntil(() => stanzas.filter(
        iq => iq.querySelector(
            `iq[to="${muc_jid}"] query[xmlns="http://jabber.org/protocol/disco#info"]`
        )).pop()
    );
    const features_stanza =
        stx`<iq from="${muc_jid}"
                id="${stanza.getAttribute('id')}"
                to="${own_jid}"
                type="error"
                xmlns="jabber:client">
            <error type="cancel">
                <item-not-found xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/>
            </error>
        </iq>`;
    _converse.api.connection.get()._dataRecv(mock.createRequest(features_stanza));
}

async function waitForMUCDiscoInfo (_converse, muc_jid, features=[], settings={}) {
    const room = Strophe.getNodeFromJid(muc_jid);
    muc_jid = muc_jid.toLowerCase();
    const stanzas = _converse.api.connection.get().IQ_stanzas;
    const stanza = await u.waitUntil(() => stanzas.filter(
        iq => iq.querySelector(
            `iq[to="${muc_jid}"] query[xmlns="http://jabber.org/protocol/disco#info"]`
        )).pop()
    );
    const features_stanza = $iq({
        'from': muc_jid,
        'id': stanza.getAttribute('id'),
        'to': 'romeo@montague.lit/desktop',
        'type': 'result'
    }).c('query', { 'xmlns': 'http://jabber.org/protocol/disco#info'})
        .c('identity', {
            'category': 'conference',
            'name': settings.name ?? `${room[0].toUpperCase()}${room.slice(1)}`,
            'type': 'text'
        }).up();

    features = features.length ? features : default_muc_features;
    features.forEach(f => features_stanza.c('feature', {'var': f}).up());
    features_stanza.c('x', { 'xmlns':'jabber:x:data', 'type':'result'})
        .c('field', {'var':'FORM_TYPE', 'type':'hidden'})
            .c('value').t('http://jabber.org/protocol/muc#roominfo').up().up()
        .c('field', {'type':'text-single', 'var':'muc#roominfo_description', 'label':'Description'})
            .c('value').t('This is the description').up().up()
        .c('field', {'type':'text-single', 'var':'muc#roominfo_occupants', 'label':'Number of occupants'})
            .c('value').t(0);
    _converse.api.connection.get()._dataRecv(createRequest(features_stanza));
}


async function waitForReservedNick (_converse, muc_jid, nick) {
    const stanzas = _converse.api.connection.get().IQ_stanzas;
    const selector = `iq[to="${muc_jid.toLowerCase()}"] query[node="x-roomuser-item"]`;
    const iq = await u.waitUntil(() => stanzas.filter(s => sizzle(selector, s).length).pop());

    // We remove the stanza, otherwise we might get stale stanzas returned in our filter above.
    stanzas.splice(stanzas.indexOf(iq), 1)

    // The XMPP server returns the reserved nick for this user.
    const IQ_id = iq.getAttribute('id');
    const stanza = $iq({
        'type': 'result',
        'id': IQ_id,
        'from': muc_jid,
        'to': _converse.api.connection.get().jid
    }).c('query', {'xmlns': 'http://jabber.org/protocol/disco#info', 'node': 'x-roomuser-item'});
    if (nick) {
        stanza.c('identity', {'category': 'conference', 'name': nick, 'type': 'text'});
    }
    _converse.api.connection.get()._dataRecv(createRequest(stanza));
    if (nick) {
        return u.waitUntil(() => nick);
    }
}


async function returnMemberLists (_converse, muc_jid, members=[], affiliations=['member', 'owner', 'admin']) {
    if (affiliations.length === 0) {
        return;
    }
    const stanzas = _converse.api.connection.get().IQ_stanzas;

    if (affiliations.includes('member')) {
        const member_IQ = await u.waitUntil(() =>
            stanzas.filter(s => sizzle(`iq[to="${muc_jid}"] query[xmlns="${Strophe.NS.MUC_ADMIN}"] item[affiliation="member"]`, s).length
        ).pop());
        const member_list_stanza = $iq({
                'from': 'coven@chat.shakespeare.lit',
                'id': member_IQ.getAttribute('id'),
                'to': 'romeo@montague.lit/orchard',
                'type': 'result'
            }).c('query', {'xmlns': Strophe.NS.MUC_ADMIN});
        members.filter(m => m.affiliation === 'member').forEach(m => {
            member_list_stanza.c('item', {
                'affiliation': m.affiliation,
                'jid': m.jid,
                'nick': m.nick
            });
        });
        _converse.api.connection.get()._dataRecv(createRequest(member_list_stanza));
    }

    if (affiliations.includes('admin')) {
        const admin_IQ = await u.waitUntil(() => stanzas.filter(
            s => sizzle(`iq[to="${muc_jid}"] query[xmlns="${Strophe.NS.MUC_ADMIN}"] item[affiliation="admin"]`, s).length
        ).pop());
        const admin_list_stanza = $iq({
                'from': 'coven@chat.shakespeare.lit',
                'id': admin_IQ.getAttribute('id'),
                'to': 'romeo@montague.lit/orchard',
                'type': 'result'
            }).c('query', {'xmlns': Strophe.NS.MUC_ADMIN});
        members.filter(m => m.affiliation === 'admin').forEach(m => {
            admin_list_stanza.c('item', {
                'affiliation': m.affiliation,
                'jid': m.jid,
                'nick': m.nick
            });
        });
        _converse.api.connection.get()._dataRecv(createRequest(admin_list_stanza));
    }

    if (affiliations.includes('owner')) {
        const owner_IQ = await u.waitUntil(() => stanzas.filter(
            s => sizzle(`iq[to="${muc_jid}"] query[xmlns="${Strophe.NS.MUC_ADMIN}"] item[affiliation="owner"]`, s).length
        ).pop());
        const owner_list_stanza = $iq({
                'from': 'coven@chat.shakespeare.lit',
                'id': owner_IQ.getAttribute('id'),
                'to': 'romeo@montague.lit/orchard',
                'type': 'result'
            }).c('query', {'xmlns': Strophe.NS.MUC_ADMIN});
        members.filter(m => m.affiliation === 'owner').forEach(m => {
            owner_list_stanza.c('item', {
                'affiliation': m.affiliation,
                'jid': m.jid,
                'nick': m.nick
            });
        });
        _converse.api.connection.get()._dataRecv(createRequest(owner_list_stanza));
    }
    return new Promise(resolve => _converse.api.listen.on('membersFetched', resolve));
}

async function receiveOwnMUCPresence (_converse, muc_jid, nick, affiliation='owner', role='moderator', features=[]) {
    const sent_stanzas = _converse.api.connection.get().sent_stanzas;
    await u.waitUntil(() => sent_stanzas.filter(iq => sizzle('presence history', iq).length).pop());

    _converse.api.connection.get()._dataRecv(createRequest(stx`
        <presence xmlns="jabber:client"
                to="${_converse.api.connection.get().jid}"
                from="${muc_jid}/${nick}"
                id="${u.getUniqueId()}">
            <x xmlns="http://jabber.org/protocol/muc#user">
                <item affiliation="${affiliation}" role="${role}" jid="${_converse.bare_jid}"/>
                <status code="110"/>
            </x>
            ${ (features.includes(Strophe.NS.OCCUPANTID))
                ? stx`<occupant-id xmlns="${Strophe.NS.OCCUPANTID}" id="${u.getUniqueId()}"/>`
                : ''
            }
            ${ _converse.state.profile.get('show')
                ? stx`<show>${_converse.state.profile.get('show')}</show>`
                : ''
            }
        </presence>`));
}

async function openAddMUCModal (_converse) {
    await mock.openControlBox(_converse);
    const controlbox = await u.waitUntil(() => _converse.chatboxviews.get('controlbox'));
    controlbox.querySelector('converse-rooms-list .show-add-muc-modal').click();
    const modal = _converse.api.modal.get('converse-add-muc-modal');
    await u.waitUntil(() => u.isVisible(modal), 1000);
    return modal;
}

async function openAndEnterMUC (
        _converse,
        muc_jid,
        nick,
        features=[],
        members=[],
        force_open=true,
        settings={},
        own_affiliation='owner',
        own_role='moderator',
    ) {
    const { api } = _converse;
    muc_jid = muc_jid.toLowerCase();

    const room_creation_promise = api.rooms.open(muc_jid, settings, force_open);
    await waitForMUCDiscoInfo(_converse, muc_jid, features, settings);
    await waitForReservedNick(_converse, muc_jid, nick);
    // The user has just entered the room (because join was called)
    // and receives their own presence from the server.
    // See example 24: https://xmpp.org/extensions/xep-0045.html#enter-pres
    await receiveOwnMUCPresence(_converse, muc_jid, nick, own_affiliation, own_role, features);

    await room_creation_promise;
    const model = _converse.chatboxes.get(muc_jid);
    await u.waitUntil(() => (model.session.get('connection_status') === converse.ROOMSTATUS.ENTERED));

    const affs = api.settings.get('muc_fetch_members');
    const all_affiliations = Array.isArray(affs) ? affs :  (affs ? ['member', 'admin', 'owner'] : []);

    if (['member', 'admin', 'owner'].includes(own_affiliation)) {
        await returnMemberLists(_converse, muc_jid, members, all_affiliations);
    }
    await model.messages.fetched;
    return model;
}

async function createContact (_converse, name, ask, requesting, subscription) {
    const jid = name.replace(/ /g,'.').toLowerCase() + '@montague.lit';
    if (_converse.roster.get(jid)) {
        return Promise.resolve();
    }
    const contact = await new Promise((success, error) => {
        _converse.roster.create({
            'fullname': name,
            ask,
            jid,
            requesting,
            subscription,
        }, {success, error});
    });
    return contact;
}

async function createContacts (_converse, type, length) {
    /* Create current (as opposed to requesting or pending) contacts
        * for the user's roster.
        *
        * These contacts are not grouped. See below.
        */
    await _converse.api.waitUntil('rosterContactsFetched');
    let names, subscription, requesting, ask;
    if (type === 'requesting') {
        names = req_names;
        subscription = 'none';
        requesting = true;
        ask = null;
    } else if (type === 'pending') {
        names = pend_names;
        subscription = 'none';
        requesting = false;
        ask = 'subscribe';
    } else if (type === 'current') {
        names = cur_names;
        subscription = 'both';
        requesting = false;
        ask = null;
    } else if (type === 'all') {
        await this.createContacts(_converse, 'current');
        await this.createContacts(_converse, 'requesting')
        await this.createContacts(_converse, 'pending');
        return this;
    } else {
        throw Error("Need to specify the type of contact to create");
    }
    const promises = names.slice(0, length).map(n => this.createContact(_converse, n, ask, requesting, subscription));
    await Promise.all(promises);
}

async function waitForRoster (_converse, type='current', length=-1, include_nick=true, grouped=true) {
    const s = `iq[type="get"] query[xmlns="${Strophe.NS.ROSTER}"]`;
    const iq = await u.waitUntil(() => _converse.api.connection.get().IQ_stanzas.filter(iq => sizzle(s, iq).length).pop());

    const result = $iq({
        'to': _converse.api.connection.get().jid,
        'type': 'result',
        'id': iq.getAttribute('id')
    }).c('query', {
        'xmlns': 'jabber:iq:roster'
    });
    if (type === 'pending' || type === 'all') {
        ((length > -1) ? pend_names.slice(0, length) : pend_names).map(name =>
            result.c('item', {
                jid: `${name.replace(/ /g,'.').toLowerCase()}@${domain}`,
                name: include_nick ? name : undefined,
                subscription: 'none',
                ask: 'subscribe'
            }).up()
        );
    }
    if (type === 'current' || type === 'all') {
        const cur_names = Object.keys(current_contacts_map);
        const names = (length > -1) ? cur_names.slice(0, length) : cur_names;
        names.forEach(name => {
            result.c('item', {
                jid: `${name.replace(/ /g,'.').toLowerCase()}@${domain}`,
                name: include_nick ? name : undefined,
                subscription: 'both',
                ask: null
            });
            if (grouped) {
                current_contacts_map[name].forEach(g => result.c('group').t(g).up());
            }
            result.up();
        });
    }
    _converse.api.connection.get()._dataRecv(createRequest(result));
    await _converse.api.waitUntil('rosterContactsFetched');
}

function createChatMessage (_converse, sender_jid, message, type='chat') {
    return $msg({
                from: sender_jid,
                to: _converse.api.connection.get().jid,
                type,
                id: (new Date()).getTime()
            })
            .c('body').t(message).up()
            .c('markable', {'xmlns': Strophe.NS.MARKERS}).up()
            .c('active', {'xmlns': Strophe.NS.CHATSTATES}).tree();
}

async function sendMessage (view, message) {
    const promise = new Promise(resolve => view.model.messages.once('rendered', resolve));
    const textarea = await u.waitUntil(() => view.querySelector('.chat-textarea'));
    textarea.value = message;
    const message_form = view.querySelector('converse-message-form') || view.querySelector('converse-muc-message-form');
    message_form.onKeyDown({
        target: view.querySelector('textarea.chat-textarea'),
        preventDefault: () => {},
        key: "Enter",
    });
    return promise;
}

window.libsignal = {
    'SignalProtocolAddress': function (name, device_id) {
        this.name = name;
        this.deviceId = device_id;
    },
    'SessionCipher': function (storage, remote_address) {
        this.remoteAddress = remote_address;
        this.storage = storage;
        this.encrypt = () => Promise.resolve({
            'type': 1,
            'body': 'c1ph3R73X7',
            'registrationId': '1337'
        });
        this.decryptPreKeyWhisperMessage = (key_and_tag) => {
            return Promise.resolve(key_and_tag);
        };
        this.decryptWhisperMessage = (key_and_tag) => {
            return Promise.resolve(key_and_tag);
        }
    },
    'SessionBuilder': function (storage, remote_address) { // eslint-disable-line no-unused-vars
        this.processPreKey = function () {
            return Promise.resolve();
        }
    },
    'KeyHelper': {
        'generateIdentityKeyPair': function () {
            return Promise.resolve({
                'pubKey': new TextEncoder('utf-8').encode('1234'),
                'privKey': new TextEncoder('utf-8').encode('4321')
            });
        },
        'generateRegistrationId': function () {
            return '123456789';
        },
        'generatePreKey': function (keyid) {
            return Promise.resolve({
                'keyId': keyid,
                'keyPair': {
                    'pubKey': new TextEncoder('utf-8').encode('1234'),
                    'privKey': new TextEncoder('utf-8').encode('4321')
                }
            });
        },
        'generateSignedPreKey': function (identity_keypair, keyid) {
            return Promise.resolve({
                'signature': new TextEncoder('utf-8').encode('11112222333344445555'),
                'keyId': keyid,
                'keyPair': {
                    'pubKey': new TextEncoder('utf-8').encode('1234'),
                    'privKey': new TextEncoder('utf-8').encode('4321')
                }
            });
        }
    }
}

const default_muc_features = [
    'http://jabber.org/protocol/muc',
    'jabber:iq:register',
    Strophe.NS.SID,
    Strophe.NS.MAM,
    'muc_passwordprotected',
    'muc_hidden',
    'muc_temporary',
    'muc_open',
    'muc_unmoderated',
    'muc_anonymous'
];

const view_mode = 'overlayed';

const domain = 'montague.lit';

// Names from http://www.fakenamegenerator.com/
const req_names = [
    'Escalus, prince of Verona', 'The Nurse', 'Paris'
];


const pend_names = [
    'Lord Capulet', 'Guard', 'Servant'
];
const current_contacts_map = {
    'Mercutio': ['Colleagues', 'friends & acquaintences'],
    'Juliet Capulet': ['friends & acquaintences'],
    'Lady Montague': ['Colleagues', 'Family'],
    'Lord Montague': ['Family'],
    'Friar Laurence': ['friends & acquaintences'],
    'Tybalt': ['friends & acquaintences'],
    'Lady Capulet': ['ænemies'],
    'Benviolo': ['friends & acquaintences'],
    'Balthasar': ['Colleagues'],
    'Peter': ['Colleagues'],
    'Abram': ['Colleagues'],
    'Sampson': ['Colleagues'],
    'Gregory': ['friends & acquaintences'],
    'Potpan': [],
    'Friar John': []
}


const map = current_contacts_map;
const groups_map = {};
Object.keys(map).forEach(k => {
    const groups = map[k].length ? map[k] : ["Ungrouped"];
    Object.values(groups).forEach(g => {
        groups_map[g] = groups_map[g] ? [...groups_map[g], k] : [k]
    });
});

const cur_names = Object.keys(current_contacts_map);
const num_contacts = req_names.length + pend_names.length + cur_names.length;

const req_jids = req_names.map((name) => `${name.replace(/ /g, '.').toLowerCase()}@${domain}`);
const cur_jids = cur_names.map((name) => `${name.replace(/ /g, '.').toLowerCase()}@${domain}`);

const groups = {
    'colleagues': 3,
    'friends & acquaintences': 3,
    'Family': 4,
    'ænemies': 3,
    'Ungrouped': 2
}

const chatroom_names = [
    'Dyon van de Wege',
    'Thomas Kalb',
    'Dirk Theissen',
    'Felix Hofmann',
    'Ka Lek',
    'Anne Ebersbacher'
];

// TODO: need to also test other roles and affiliations
const chatroom_roles = {
    'Anne Ebersbacher': { affiliation: "owner", role: "moderator" },
    'Dirk Theissen': { affiliation: "admin", role: "moderator" },
    'Dyon van de Wege': { affiliation: "member", role: "occupant" },
    'Felix Hofmann': { affiliation: "member", role: "occupant" },
    'Ka Lek': { affiliation: "member", role: "occupant" },
    'Thomas Kalb': { affiliation: "member", role: "occupant" }
}

const event = {
    'preventDefault': function () {}
}

function clearIndexedDB () {
    const promise = u.getOpenPromise();
    const db_request = window.indexedDB.open("converse-test-persistent");
    db_request.onsuccess = function () {
        const db = db_request.result;
        const bare_jid = "romeo@montague.lit";
        let store;
        try {
            store= db.transaction([bare_jid], "readwrite").objectStore(bare_jid);
        } catch (e) {
            return promise.resolve();
        }
        const request = store.clear();
        request.onsuccess = promise.resolve();
        request.onerror = promise.resolve();
    };
    db_request.onerror = function (ev) {
        return promise.reject(ev.target.error);
    }
    return promise;
}

function clearStores () {
    [localStorage, sessionStorage].forEach(
        s => Object.keys(s).forEach(k => k.match(/^converse-test-/) && s.removeItem(k))
    );
    const cache_key = `converse.room-bookmarksromeo@montague.lit`;
    window.sessionStorage.removeItem(cache_key+'fetched');
}

function getMockVcardFetcher (settings) {
    return (model, force) => {
        let jid;
        if (typeof model === 'string' || model instanceof String) {
            jid = model;
        } else if (!model.get('vcard_updated') || force) {
            jid = model.get('jid') || model.get('muc_jid');
        }

        let fullname;
        let nickname;
        if (!jid || jid == 'romeo@montague.lit') {
            jid = settings?.vcard?.jid ?? 'romeo@montague.lit';
            fullname = settings?.vcard?.display_name ?? 'Romeo Montague' ;
            nickname = settings?.vcard?.nickname ?? 'Romeo';
        } else {
            const name = jid.split('@')[0].replace(/\./g, ' ').split(' ');
            const last = name.length-1;
            name[0] =  name[0].charAt(0).toUpperCase()+name[0].slice(1);
            name[last] = name[last].charAt(0).toUpperCase()+name[last].slice(1);
            fullname = name.join(' ');
        }
        const vcard = $iq().c('vCard').c('FN').t(fullname).up();
        if (nickname) vcard.c('NICKNAME').t(nickname);
        const vcard_el = vcard.tree();

        return Promise.resolve({
            stanza: vcard_el,
            fullname: vcard_el.querySelector('FN')?.textContent,
            nickname: vcard_el.querySelector('NICKNAME')?.textContent,
            image: vcard_el.querySelector('PHOTO BINVAL')?.textContent,
            image_type: vcard_el.querySelector('PHOTO TYPE')?.textContent,
            url: vcard_el.querySelector('URL')?.textContent,
            vcard_updated: dayjs().format(),
            vcard_error: undefined
        });
    }
}

const theme = ['dracula', 'classic', 'cyberpunk', 'nordic'][Math.floor(Math.random()*4)];
let originalVCardGet;

async function _initConverse (settings) {
    clearStores();
    await clearIndexedDB();


    _converse = await converse.initialize(Object.assign({
        animate: false,
        auto_subscribe: false,
        bosh_service_url: 'montague.lit/http-bind',
        disable_effects: true,
        discover_connection_methods: false,
        embed_3rd_party_media_players: false,
        enable_smacks: false,
        fetch_url_headers: false,
        i18n: 'en',
        loglevel: window.location.pathname === '/debug.html' ? 'debug' : 'error',
        no_trimming: true,
        persistent_store: 'localStorage',
        play_sounds: false,
        theme,
        use_emojione: false,
        view_mode,
    }, settings || {}));

    window._converse = _converse;

    originalVCardGet = originalVCardGet || _converse.api.vcard.get;

    if (!settings?.no_vcard_mocks && _converse.api.vcard) {
        _converse.api.vcard.get = getMockVcardFetcher(settings);
    } else {
        _converse.api.vcard.get = originalVCardGet;
    }

    if (settings?.auto_login !== false) {
        await _converse.api.user.login('romeo@montague.lit/orchard', 'secret');
    }
    return _converse;
}


async function deviceListFetched (_converse, jid, device_ids) {
    const selector = `iq[to="${jid}"] items[node="eu.siacs.conversations.axolotl.devicelist"]`;
    const iq_stanza = await u.waitUntil(
        () => Array.from(_converse.api.connection.get().IQ_stanzas).filter(iq => iq.querySelector(selector)).pop()
    );
    await u.waitUntil(() => _converse.state.devicelists.get(jid));
    if (Array.isArray(device_ids)) {
        const stanza = stx`<iq from="${jid}"
                            xmlns="jabber:server"
                            id="${iq_stanza.getAttribute('id')}"
                            to="${_converse.api.connection.get().jid}"
                            type="result">
            <pubsub xmlns="http://jabber.org/protocol/pubsub">
                <items node="eu.siacs.conversations.axolotl.devicelist">
                    <item xmlns="http://jabber.org/protocol/pubsub">
                        <list xmlns="eu.siacs.conversations.axolotl">
                            ${device_ids.map((id) => stx`<device id="${id}"/>`)}
                        </list>
                    </item>
                </items>
            </pubsub>
        </iq>`;
        _converse.api.connection.get()._dataRecv(mock.createRequest(stanza));
    }
    return iq_stanza;
}

function ownDeviceHasBeenPublished (_converse) {
    return Array.from(_converse.api.connection.get().IQ_stanzas).filter(
        iq => iq.querySelector('iq[from="'+_converse.bare_jid+'"] publish[node="eu.siacs.conversations.axolotl.devicelist"]')
    ).pop();
}

function bundleHasBeenPublished (_converse) {
    const selector = 'publish[node="eu.siacs.conversations.axolotl.bundles:123456789"]';
    return Array.from(_converse.api.connection.get().IQ_stanzas).filter(iq => iq.querySelector(selector)).pop();
}

function bundleIQRequestSent(_converse, jid, device_id) {
    return Array.from(_converse.api.connection.get().IQ_stanzas).filter(
        iq => iq.querySelector(`iq[to="${jid}"] items[node="eu.siacs.conversations.axolotl.bundles:${device_id}"]`)
    ).pop();
}

async function bundleFetched(
    _converse,
    {
        jid,
        device_id,
        identity_key,
        signed_prekey_id,
        signed_prekey_public,
        signed_prekey_sig,
        prekeys,
    }
) {
    const iq_stanza = await u.waitUntil(() => bundleIQRequestSent(_converse, jid, device_id));
    const stanza = stx`<iq from="${jid}"
            id="${iq_stanza.getAttribute("id")}"
            to="${_converse.bare_jid}"
            xmlns="jabber:server"
            type="result">
        <pubsub xmlns="http://jabber.org/protocol/pubsub">
            <items node="eu.siacs.conversations.axolotl.bundles:${device_id}">
                <item>
                    <bundle xmlns="eu.siacs.conversations.axolotl">
                        <signedPreKeyPublic signedPreKeyId="${signed_prekey_id}">${btoa(signed_prekey_public)}</signedPreKeyPublic>
                        <signedPreKeySignature>${btoa(signed_prekey_sig)}</signedPreKeySignature>
                        <identityKey>${btoa(identity_key)}</identityKey>
                        <prekeys>
                            ${prekeys.map((k, i) => stx`<preKeyPublic preKeyId="${i}">${btoa(k)}</preKeyPublic>`)}
                        </prekeys>
                    </bundle>
                </item>
            </items>
        </pubsub>
    </iq>`;
    _converse.api.connection.get()._dataRecv(mock.createRequest(stanza));
}

async function initializedOMEMO(
    _converse,
    identities = [{ 'category': 'pubsub', 'type': 'pep' }],
    features = ['http://jabber.org/protocol/pubsub#publish-options']
) {
    await waitUntilDiscoConfirmed(_converse, _converse.bare_jid, identities, features);
    await deviceListFetched(_converse, _converse.bare_jid, ['482886413b977930064a5888b92134fe']);
    let iq_stanza = await u.waitUntil(() => ownDeviceHasBeenPublished(_converse));

    let stanza = $iq({
        'from': _converse.bare_jid,
        'id': iq_stanza.getAttribute('id'),
        'to': _converse.bare_jid,
        'type': 'result',
    });
    _converse.api.connection.get()._dataRecv(createRequest(stanza));

    iq_stanza = await u.waitUntil(() => bundleHasBeenPublished(_converse));

    stanza = $iq({
        'from': _converse.bare_jid,
        'id': iq_stanza.getAttribute('id'),
        'to': _converse.bare_jid,
        'type': 'result',
    });
    _converse.api.connection.get()._dataRecv(createRequest(stanza));
    await _converse.api.waitUntil('OMEMOInitialized');
}

Object.assign(mock, {
    bundleFetched,
    bundleHasBeenPublished,
    bundleIQRequestSent,
    chatroom_names,
    chatroom_roles,
    checkHeaderToggling,
    closeAllChatBoxes,
    closeControlBox,
    createChatMessage,
    createContact,
    createContacts,
    createRequest,
    cur_jids,
    cur_names,
    current_contacts_map,
    default_muc_features,
    deviceListFetched,
    event,
    getContactJID,
    groups,
    groups_map,
    initConverse,
    initializedOMEMO,
    num_contacts,
    openAddMUCModal,
    openAndEnterMUC,
    openChatBoxFor,
    openChatBoxes,
    openControlBox,
    ownDeviceHasBeenPublished,
    pend_names,
    receiveOwnMUCPresence,
    req_jids,
    req_names,
    returnMemberLists,
    sendMessage,
    toggleControlBox,
    view_mode,
    waitForMUCDiscoInfo,
    waitForNewMUCDiscoInfo,
    waitForReservedNick,
    waitForRoster,
    waitUntilBlocklistInitialized,
    waitUntilBookmarksReturned,
    waitUntilDiscoConfirmed
});

window.mock = mock;
