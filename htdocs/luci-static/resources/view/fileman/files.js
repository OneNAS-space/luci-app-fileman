'use strict';
'require view';
'require fs';
'require ui';
'require rpc';

/*
 * File Manager
 *
 * Browse, upload, download, rename, delete and install packages (apk / ipk).
 * Everything goes through rpcd's "file" plugin and cgi-io, authorised by
 * /usr/share/rpcd/acl.d/luci-app-advanced.json. No shell command lines are
 * built from user input: commands are executed with an argument array.
 *
 * NOTE: LuCI's E() treats a single non-array string child as HTML. Anything
 * that comes from the file system (names, paths, command output) is therefore
 * always passed inside an array (text node) or assigned via textContent.
 */

const CSS_URL = L.resource('fileman/fileman.css');
const MAX_LINK_LOOKUPS = 200;

/* ---------- path helpers ---------- */

function normalizePath(p) {
	const parts = [];

	String(p || '/').split('/').forEach(seg => {
		if (seg === '' || seg === '.')
			return;
		if (seg === '..')
			parts.pop();
		else
			parts.push(seg);
	});

	return '/' + parts.join('/');
}

function joinPath(dir, name) {
	return normalizePath(dir + '/' + name);
}

function parentPath(p) {
	return normalizePath(p + '/..');
}

/* ---------- formatting helpers ---------- */

function pad(n) {
	return (n < 10 ? '0' : '') + n;
}

function formatDate(ts) {
	if (!ts)
		return '-';

	const d = new Date(ts * 1000);

	return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
		' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function modeString(type, mode) {
	const t = { directory: 'd', symlink: 'l', block: 'b', char: 'c', fifo: 'p', socket: 's' }[type] || '-';
	const m = (mode || 0) & 0o777;
	let s = t;

	'rwxrwxrwx'.split('').forEach((c, i) => {
		s += (m & (1 << (8 - i))) ? c : '-';
	});

	return s;
}

function errText(err) {
	return (err && err.message) ? err.message : String(err);
}

function showError(msg) {
	ui.addNotification(null, E('p', {}, [ String(msg) ]), 'danger');
}

/* ---------- rpc helpers ---------- */

function checkExec(res) {
	if (!res || res.code !== 0)
		throw new Error(String((res && (res.stderr || res.stdout)) || _('Operation failed')).trim());

	return res;
}

function readlink(path) {
	return fs.exec('/usr/bin/readlink', [ path ]).catch(() => fs.exec('/bin/readlink', [ path ]));
}

function resolveLink(full) {
	return Promise.all([
		readlink(full).then(
			r => (r && r.code === 0) ? String(r.stdout || '').trim() : null,
			() => null),
		fs.stat(full).then(s => {
			if (s.type !== 'symlink')
				return s.type;

			/* stat may not follow the link: fall back to a listing probe */
			return fs.list(full).then(() => 'directory', () => 'file');
		}, () => null)
	]).then(r => ({ target: r[0], type: r[1] }));
}

function detectPkgManager() {
	const probe = (bin, name) => fs.stat(bin).then(() => ({ name: name, bin: bin }), () => null);

	return Promise.all([
		probe('/usr/bin/apk', 'apk'),
		probe('/sbin/apk', 'apk'),
		probe('/bin/opkg', 'opkg'),
		probe('/usr/bin/opkg', 'opkg')
	]).then(r => r.filter(Boolean)[0] || null);
}

function clearLuciCache() {
	return fs.list('/tmp').then(list => {
		const targets = list
			.filter(x => /^luci-/.test(x.name))
			.map(x => '/tmp/' + x.name);

		if (!targets.length)
			return null;

		return fs.exec('/bin/rm', [ '-rf' ].concat(targets));
	}).catch(() => null);
}

/* ---------- transfer helpers ---------- */

function downloadFile(path, name) {
	const form = E('form', {
		'method': 'post',
		'action': L.env.cgi_base + '/cgi-download',
		'style': 'display:none'
	}, [
		E('input', { 'type': 'hidden', 'name': 'sessionid', 'value': rpc.getSessionID() }),
		E('input', { 'type': 'hidden', 'name': 'path', 'value': path }),
		E('input', { 'type': 'hidden', 'name': 'filename', 'value': name })
	]);

	document.body.appendChild(form);
	form.submit();
	document.body.removeChild(form);
}

function uploadOne(destPath, file, onProgress) {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		const data = new FormData();

		/* cgi-io reads the fields in order: filedata must come last */
		data.append('sessionid', rpc.getSessionID());
		data.append('filename', destPath);
		data.append('filemode', '0644');
		data.append('filedata', file);

		xhr.open('POST', L.env.cgi_base + '/cgi-upload', true);

		xhr.upload.onprogress = ev => {
			if (ev.lengthComputable)
				onProgress(ev.loaded / ev.total);
		};

		xhr.onload = () => {
			let res = null;

			try { res = JSON.parse(xhr.responseText); } catch (e) { res = null; }

			if (xhr.status === 200 && res && !res.failure)
				resolve(res);
			else if (res && Array.isArray(res.failure))
				reject(new Error(res.failure[1] || _('The upload failed. Please try again later....')));
			else
				reject(new Error(xhr.statusText || _('The upload failed. Please try again later....')));
		};

		xhr.onerror = () => reject(new Error(_('The upload failed. Please try again later....')));

		xhr.send(data);
	});
}

/* ---------- view ---------- */

return view.extend({
	pm: null,
	cwd: null,
	entries: [],

	load() {
		return detectPkgManager();
	},

	render(pm) {
		this.pm = pm;

		this.listEl = E('div', { 'class': 'fb-list' });

		this.pathInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text fb-path',
			'spellcheck': 'false',
			'autocomplete': 'off',
			'keydown': ev => {
				if (ev.key === 'Enter') {
					ev.preventDefault();
					this.navigate(ev.target.value);
				}
			},
			'blur': ev => {
				if (normalizePath(ev.target.value) !== this.cwd)
					this.navigate(ev.target.value);
			}
		});

		this.fileInput = E('input', { 'type': 'file', 'multiple': 'multiple', 'class': 'fb-file' });
		this.uploadStatus = E('span', { 'class': 'fb-upload-status' });
		this.uploadBtn = E('button', {
			'class': 'cbi-button cbi-button-action',
			'click': ev => {
				ev.preventDefault();
				this.handleUpload();
			}
		}, [ _('Execute the upload') ]);

		this.uploadBox = E('div', { 'class': 'fb-upload', 'style': 'display:none' }, [
			this.fileInput, this.uploadBtn, this.uploadStatus
		]);

		this.toggleBtn = E('button', {
			'class': 'cbi-button cbi-button-edit fb-toggle',
			'click': ev => {
				ev.preventDefault();
				this.toggleUpload();
			}
		}, [ _('Open Upload') ]);

		window.addEventListener('popstate', ev => {
			this.navigate((ev.state && ev.state.path) || '/', { history: false });
		});

		const initial = new URLSearchParams(window.location.search).get('path') || '/';

		this.navigate(initial, { history: 'replace' });

		return E([
			E('link', { 'rel': 'stylesheet', 'href': CSS_URL }),
			E('h2', {}, [ _('File Manager') ]),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('Integrated upload, deletion and installation, non-professionals, please operate carefully.')
			]),
			E('div', { 'class': 'cbi-section fb-container' }, [
				this.pathInput,
				E('div', { 'class': 'fb-panel' }, [
					E('div', { 'class': 'fb-title' }, [ _('File List') ]),
					this.toggleBtn
				]),
				this.uploadBox,
				this.listEl
			])
		]);
	},

	/* ----- navigation / listing ----- */

	navigate(target, opts) {
		opts = opts || {};

		const path = normalizePath(target);

		return this.readDir(path).then(entries => {
			this.cwd = path;
			this.entries = entries;
			this.pathInput.value = path;
			this.renderList();

			if (opts.history !== false) {
				const url = '?path=' + encodeURIComponent(path).replace(/%2F/g, '/');

				try {
					if (opts.history === 'replace')
						window.history.replaceState({ path: path }, '', url);
					else
						window.history.pushState({ path: path }, '', url);
				}
				catch (e) { /* ignore */ }
			}
		}).catch(err => {
			showError(path + ': ' + errText(err));

			if (this.cwd === null && path !== '/')
				return this.navigate('/', { history: 'replace' });

			this.pathInput.value = this.cwd || '/';
		});
	},

	reload() {
		return this.navigate(this.cwd || '/', { history: false });
	},

	readDir(path) {
		return fs.list(path).then(entries => {
			entries = entries || [];

			const links = entries.filter(e => e.type === 'symlink');

			if (links.length > MAX_LINK_LOOKUPS)
				return entries;

			return Promise.all(links.map(e =>
				resolveLink(joinPath(path, e.name)).then(r => {
					e.target = r.target;
					e.targetType = r.type;
				})
			)).then(() => entries);
		});
	},

	renderList() {
		const isDirEntry = e => e.type === 'directory' ||
			(e.type === 'symlink' && e.targetType === 'directory');

		const sorted = this.entries.slice().sort((a, b) =>
			(isDirEntry(b) - isDirEntry(a)) || a.name.localeCompare(b.name));

		const rows = [];

		if (this.cwd !== '/') {
			rows.push(E('div', {
				'class': 'tr fb-row fb-parent cbi-rowstyle-2',
				'click': () => this.navigate(parentPath(this.cwd))
			}, [
				E('div', { 'class': 'td fb-name' }, [
					E('strong', {}, [ _('.. Return to Parent Directory') ])
				])
			]));
		}

		sorted.forEach((e, i) => rows.push(this.buildRow(e, i, isDirEntry(e))));

		L.dom.content(this.listEl, E('div', { 'class': 'table cbi-section-table' }, rows));
	},

	buildRow(e, idx, isDir) {
		const full = joinPath(this.cwd, e.name);
		const isLink = e.type === 'symlink';
		const isFile = e.type === 'file' || (isLink && e.targetType === 'file');
		const icon = isLink ? 'link-icon' : (isDir ? 'folder-icon' : 'file-icon');
		const label = (isLink && e.target) ? e.name + ' -> ' + e.target : e.name;
		const clickable = isDir || isFile;

		const nameAttrs = { 'class': 'td fb-name' + (clickable ? ' is-clickable' : '') };

		if (clickable) {
			nameAttrs.click = () => {
				if (isDir)
					this.navigate(full);
				else
					downloadFile(full, e.name);
			};
		}

		const nameEl = E('strong', {});
		nameEl.textContent = label;

		const actions = [
			E('button', {
				'class': 'cbi-button cbi-button-edit',
				'click': ev => {
					ev.preventDefault();
					this.handleRename(e);
				}
			}, [ _('Rename') ]),
			' ',
			E('button', {
				'class': 'cbi-button cbi-button-remove',
				'click': ev => {
					ev.preventDefault();
					this.handleDelete(e);
				}
			}, [ _('Delete') ])
		];

		if (isFile && this.installerFor(e.name)) {
			actions.push(' ', E('button', {
				'class': 'cbi-button cbi-button-action',
				'click': ev => {
					ev.preventDefault();
					this.handleInstall(e);
				}
			}, [ _('Install') ]));
		}

		const dateEl = E('div', { 'class': 'td fb-date' });
		dateEl.textContent = formatDate(e.mtime);

		const sizeEl = E('div', { 'class': 'td fb-size' });
		sizeEl.textContent = (isDir || e.size == null) ? '-' : '%1024.2mB'.format(e.size);

		const permEl = E('div', { 'class': 'td fb-perm' });
		permEl.textContent = modeString(e.type, e.mode);

		return E('div', { 'class': 'tr fb-row cbi-rowstyle-' + (1 + idx % 2) }, [
			E('div', nameAttrs, [ E('span', { 'class': 'fb-entry ' + icon }, [ nameEl ]) ]),
			dateEl,
			sizeEl,
			permEl,
			E('div', { 'class': 'td fb-actions' }, actions)
		]);
	},

	/* ----- package installation ----- */

	installerFor(filename) {
		const pm = this.pm;

		if (!pm)
			return null;

		if (pm.name === 'apk' && /\.apk$/i.test(filename))
			return { bin: pm.bin, args: path => [ 'add', '--allow-untrusted', path ] };

		if (pm.name === 'opkg' && /\.ipk$/i.test(filename))
			return { bin: pm.bin, args: path => [ '--force-depends', 'install', path ] };

		return null;
	},

	handleInstall(e) {
		const full = joinPath(this.cwd, e.name);
		const inst = this.installerFor(e.name);

		if (!inst) {
			showError(_('Only files in ipk format are allowed to be installed!'));
			return;
		}

		ui.showModal(_('Install'), [
			E('p', {}, [ _('Do u want to install %s ?').format(e.name) ]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, [ _('Cancel') ]),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-positive important',
					'click': () => this.doInstall(inst, full)
				}, [ _('Install') ])
			])
		]);
	},

	doInstall(inst, full) {
		ui.showModal(_('Install'), [
			E('p', { 'class': 'spinning' }, [ _('Installing…') ])
		]);

		return fs.exec(inst.bin, inst.args(full)).then(res => {
			if (!res || res.code !== 0)
				return this.showInstallResult(false, res);

			return clearLuciCache().then(() => this.showInstallResult(true, res));
		}).catch(err => this.showInstallResult(false, { stderr: errText(err) }));
	},

	showInstallResult(ok, res) {
		const output = String((res && ((res.stdout || '') + (res.stderr || ''))) || '').trim().slice(-4000);
		const body = [
			E('p', {}, [ ok ? _('Successful installation.') : _('Installation failed. Please check the file format.') ])
		];

		if (output) {
			const pre = E('pre', { 'class': 'fb-output' });
			pre.textContent = output;
			body.push(pre);
		}

		body.push(E('div', { 'class': 'right' }, [
			E('button', {
				'class': 'btn cbi-button cbi-button-positive important',
				'click': () => {
					ui.hideModal();

					if (ok)
						window.location.reload();
				}
			}, [ _('Dismiss') ])
		]));

		ui.showModal(_('Install'), body);
	},

	/* ----- delete / rename ----- */

	handleDelete(e) {
		const full = joinPath(this.cwd, e.name);
		const isDir = e.type === 'directory';

		ui.showModal(_('Delete'), [
			E('p', {}, [ _('Do u want to delete %s ?').format(e.name) ]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, [ _('Cancel') ]),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-negative important',
					'click': () => this.doDelete(full, isDir)
				}, [ _('Delete') ])
			])
		]);
	},

	doDelete(full, isDir) {
		ui.hideModal();

		/* symlinks are unlinked, only real directories are removed recursively */
		const op = isDir
			? fs.exec('/bin/rm', [ '-r', full ]).then(checkExec)
			: fs.remove(full);

		return op
			.catch(err => showError(errText(err)))
			.then(() => this.reload());
	},

	handleRename(e) {
		const input = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'value': e.name,
			'style': 'width:100%',
			'keydown': ev => {
				if (ev.key === 'Enter') {
					ev.preventDefault();
					ok.click();
				}
			}
		});

		const ok = E('button', {
			'class': 'btn cbi-button cbi-button-positive important',
			'click': () => this.doRename(e, input.value)
		}, [ _('Rename') ]);

		ui.showModal(_('Rename'), [
			E('p', {}, [ _('Please enter the new file name.') ]),
			input,
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, [ _('Cancel') ]),
				' ',
				ok
			])
		]);

		input.focus();
		input.select();
	},

	doRename(e, newName) {
		newName = String(newName || '').trim();

		if (!newName || newName === e.name) {
			ui.hideModal();
			return Promise.resolve();
		}

		ui.hideModal();

		if (newName === '.' || newName === '..' || newName.indexOf('/') !== -1) {
			showError(_('Invalid file name'));
			return Promise.resolve();
		}

		const from = joinPath(this.cwd, e.name);
		const to = joinPath(this.cwd, newName);

		return fs.stat(to)
			.then(() => { throw new Error(_('"%s" already exists').format(newName)); }, () => null)
			.then(() => fs.exec('/bin/mv', [ from, to ]))
			.then(checkExec)
			.catch(err => showError(errText(err)))
			.then(() => this.reload());
	},

	/* ----- upload ----- */

	toggleUpload() {
		const hidden = this.uploadBox.style.display === 'none';

		this.uploadBox.style.display = hidden ? 'flex' : 'none';
		this.toggleBtn.textContent = hidden ? _('Collapse Upload') : _('Open Upload');
	},

	handleUpload() {
		const files = Array.prototype.slice.call(this.fileInput.files || []);

		if (!files.length)
			return Promise.resolve();

		const existing = files
			.filter(f => this.entries.some(e => e.name === f.name))
			.map(f => f.name);

		if (!existing.length)
			return this.uploadFiles(files);

		ui.showModal(_('Execute the upload'), [
			E('p', {}, [ _('Overwrite existing file(s): %s ?').format(existing.join(', ')) ]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, [ _('Cancel') ]),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-positive important',
					'click': () => this.uploadFiles(files)
				}, [ _('Execute the upload') ])
			])
		]);

		return Promise.resolve();
	},

	uploadFiles(files) {
		ui.hideModal();

		const dir = this.cwd;
		let chain = Promise.resolve();

		this.uploadBtn.disabled = true;
		this.fileInput.disabled = true;

		files.forEach((file, i) => {
			chain = chain.then(() =>
				uploadOne(joinPath(dir, file.name), file, p => {
					this.uploadStatus.textContent = '%s (%d/%d) %d%%'.format(
						file.name, i + 1, files.length, Math.round(p * 100));
				}).catch(err => showError('%s: %s'.format(file.name, errText(err))))
			);
		});

		return chain.then(() => {
			this.fileInput.value = '';
			this.fileInput.disabled = false;
			this.uploadBtn.disabled = false;
			this.uploadStatus.textContent = '';

			return this.reload();
		});
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
