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

function errText(err) {
        return (err && err.message) ? err.message : String(err);
}

function readText(path) {
        return fs.read(path).then(s => String(s || ''), () => '');
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
                const prompt = 'root@' + data[2] + ':~# ';
                const stats = data[3];

                const preview = E('pre', { 'class': 'sysinfo-preview' });
                preview.textContent = banner + (enabled ? stats : '') + prompt;

                const status = E('strong', { 'style': 'color:' + (enabled ? 'green' : 'red') });
                status.textContent = enabled ? _('Enabled') : _('Disabled');

                const btn = E('button', {
                        'class': 'btn cbi-button ' + (enabled ? 'cbi-button-negative' : 'cbi-button-positive'),
                        'click': ev => {
                                ev.preventDefault();
                                btn.disabled = true;
                                btn.textContent = _('Applying...');

                                const op = enabled ? fs.remove(HOOK_FILE) : fs.write(HOOK_FILE, HOOK_BODY);

                                return op.then(() => window.location.reload()).catch(err => {
                                        btn.disabled = false;
                                        btn.textContent = enabled ? _('Click to disable') : _('Click to enable');
                                        ui.addNotification(null, E('p', {}, [ _('Failed to change status: ') + errText(err) ]), 'danger');
                                });
                        }
                }, [ enabled ? _('Click to disable') : _('Click to enable') ]);

                return E([
                        E('style', {}, [
                                '.sysinfo-preview { background:#222; color:#eee; padding:10px; margin-top:1rem; border-radius:5px;' +
                                ' font-family:Consolas,Monaco,monospace; font-size:11px; white-space:pre-wrap; word-wrap:break-word; }'
                        ]),
                        E('h2', {}, [ _('Login Info') ]),
                        E('div', { 'class': 'cbi-map-descr' }, [
                                _('Terminal System Information'), ': ', status
                        ]),
                        E('div', { 'class': 'cbi-section' }, [
                                preview,
                                E('div', { 'style': 'margin-top:1rem' }, [ btn ])
                        ])
                ]);
        },

        handleSave: null,
        handleSaveApply: null,
        handleReset: null
});
