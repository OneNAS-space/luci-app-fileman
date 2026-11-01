'use strict';
'require view';
'require fs';
'require ui';

/*
 * Login Info
 *
 * Shows the system summary printed by /etc/sysinfo on every login and lets
 * the user switch it on or off. Enabling creates /etc/profile.d/sysinfo.sh
 * (sourced by /etc/profile at login), disabling removes it again, so
 * /etc/profile itself is never edited.
 *
 * NOTE: LuCI's E() treats a single non-array string child as HTML, so text
 * that is not a fixed literal is always passed in an array or via textContent.
 */

const HOOK_FILE = '/etc/profile.d/sysinfo.sh';
const HOOK_BODY = '# managed by luci-app-fileman\n[ -x /etc/sysinfo ] && /etc/sysinfo\n';

const CSS =
	'.si-head { display:flex; align-items:center; flex-wrap:wrap; gap:.75rem; margin:1rem 0; }' +
	'.si-badge { display:inline-flex; align-items:center; gap:.4rem; height:auto; min-height:0; line-height:1.4; padding:.25rem .8rem; margin:0; border-radius:999px; font-weight:600; font-size:.9rem; border:0; box-shadow:none; cursor:pointer; transition:filter .15s; }' +
	'.si-badge:hover { filter:brightness(.95); }' +
	'.si-badge:disabled { opacity:.6; cursor:default; }' +
	'.si-badge::before { content:""; width:.55rem; height:.55rem; border-radius:50%; background:currentColor; }' +
	'.si-badge.on { color:#1a7f37; background:#dafbe1; }' +
	'.si-badge.off { color:#82071e; background:#ffebe9; }' +
	'.si-term { border-radius:.6rem; overflow:hidden; border:1px solid rgba(128,128,128,.3); background:transparent; margin:0; }' +
	'.si-term-bar { display:flex; align-items:center; gap:.4rem; padding:.55rem .8rem; background:rgba(128,128,128,.12); border-bottom:1px solid rgba(128,128,128,.2); }' +
	'.si-term-bar i { width:.7rem; height:.7rem; border-radius:50%; display:inline-block; }' +
	'.si-term-bar span { margin-left:.6rem; opacity:.65; font:12px Consolas,Monaco,monospace; }' +
	'.si-pre { margin:0; padding:1rem 1.2rem; border:0; border-radius:0; background:transparent !important; color:inherit; font:13px/1.5 Consolas,Monaco,"Courier New",monospace; white-space:pre-wrap; word-wrap:break-word; overflow-x:auto; }' +
	'.si-banner { color:#2da44e; }' +
	'.si-dim { opacity:.45; }' +
	'.si-key { color:#3b82f6; }' +
	'.si-val { color:inherit; }' +
	'.si-head2 { color:#d97706; font-weight:bold; }' +
	'.si-prompt { color:#2da44e; }' +
	'.si-cursor { display:inline-block; width:.55em; height:1.05em; background:currentColor; vertical-align:text-bottom; animation:si-blink 1.1s steps(1) infinite; }' +
	'@keyframes si-blink { 50% { opacity:0; } }';

function errText(err) {
	return (err && err.message) ? err.message : String(err);
}

function readText(path) {
	return fs.read(path).then(s => String(s || ''), () => '');
}

function span(cls, text) {
	const n = E('span', { 'class': cls });
	n.textContent = text;
	return n;
}

/* colourise the raw text (a colon only ends the key when whitespace follows it, so labels such as "br-lan:vip" stay in the key): banner, separators, "key: value" lines and section headings */
function renderLines(banner, stats) {
	const out = [];

	String(banner).replace(/\n+$/, '').split('\n').forEach(l => {
		out.push(span(/^[\s-]*$/.test(l) || /^-{5,}/.test(l.trim()) ? 'si-dim' : 'si-banner', l + '\n'));
	});

	String(stats).replace(/\n+$/, '').split('\n').forEach(l => {
		let m;

		if (/^\s*-{5,}\s*$/.test(l))
			out.push(span('si-dim', l + '\n'));
		else if ((m = l.match(/^(\s*)((?:WAN|LAN|WIFI) Interfaces List[^:]*):(.*)$/)))
			out.push(E('span', {}, [ m[1], span('si-head2', m[2] + ':'), span('si-val', m[3] + '\n') ]));
		else if ((m = l.match(/^(\s*)((?:[^:]|:(?!\s)){1,40}):(\s+.*)$/)))
			out.push(E('span', {}, [ m[1], span('si-key', m[2] + ':'), span('si-val', m[3] + '\n') ]));
		else
			out.push(span('si-val', l + '\n'));
	});

	return out;
}

return view.extend({
	load() {
		return Promise.all([
			fs.stat(HOOK_FILE).then(() => true, () => false),
			readText('/etc/banner'),
			fs.trimmed('/proc/sys/kernel/hostname').then(s => s || 'OpenWrt', () => 'OpenWrt'),
			fs.exec('/etc/sysinfo').then(
				r => (r && r.code === 0) ? String(r.stdout || '') : String((r && (r.stderr || r.stdout)) || ''),
				err => 'Error: ' + errText(err) + '\n')
		]);
	},

	render(data) {
		const enabled = data[0];
		const banner = data[1];
		const host = data[2];
		const stats = data[3];

		const label = enabled ? _('Enabled') : _('Disabled');

		const badge = E('button', {
			'class': 'si-badge ' + (enabled ? 'on' : 'off'),
			'type': 'button',
			'title': enabled ? _('Click to disable') : _('Click to enable'),
			'click': ev => {
				ev.preventDefault();
				badge.disabled = true;
				badge.textContent = _('Applying...');

				const op = enabled ? fs.remove(HOOK_FILE) : fs.write(HOOK_FILE, HOOK_BODY);

				return op.then(() => window.location.reload()).catch(err => {
					badge.disabled = false;
					badge.textContent = label;
					ui.addNotification(null, E('p', {}, [ _('Failed to change status: ') + errText(err) ]), 'danger');
				});
			}
		}, [ label ]);

		const term = E('pre', { 'class': 'si-pre' }, enabled ? renderLines(banner, stats) : renderLines(banner, ''));

		term.appendChild(span('si-prompt', 'root@' + host + ':~# '));
		term.appendChild(E('span', { 'class': 'si-cursor' }));

		const titleBar = E('div', { 'class': 'si-term-bar' }, [
			E('i', { 'style': 'background:#ff5f57' }),
			E('i', { 'style': 'background:#febc2e' }),
			E('i', { 'style': 'background:#28c840' }),
			span('', 'root@' + host + ' — ' + _('login preview'))
		]);

		const children = [
			E('style', {}, [ CSS ]),
			E('h2', {}, [ _('Login Info') ]),
			E('div', { 'class': 'si-head' }, [
				span('', _('Terminal System Information')),
				badge
			])
		];

		children.push(E('div', { 'class': 'si-term' }, [ titleBar, term ]));

		return E(children);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
