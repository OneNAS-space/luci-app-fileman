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

		this.upBtn = E('button', {
			'class': 'cbi-button fb-up',
			'type': 'button',
			'title': _('Parent Directory'),
			'click': ev => {
				ev.preventDefault();
				this.navigate(parentPath(this.cwd));
			}
		}, [ '\u2191' ]);

		this.fileInput = E('input', {
			'type': 'file',
			'multiple': 'multiple',
			'style': 'display:none',
			'change': () => this.handleUpload(Array.prototype.slice.call(this.fileInput.files || []))
		});

		this.uploadStatus = E('span', { 'class': 'fb-upload-status' });

		this.uploadBtn = E('button', {
			'class': 'cbi-button cbi-button-action fb-upload-btn',
			'click': ev => {
				ev.preventDefault();
				this.fileInput.click();
			}
		}, [ _('Upload') ]);

		/* drop files anywhere on the list to upload them into the current directory */
		const hasFiles = ev => !!(ev.dataTransfer && Array.prototype.indexOf.call(ev.dataTransfer.types || [], 'Files') !== -1);

		this.listEl.addEventListener('dragover', ev => {
			if (!hasFiles(ev))
				return;

			ev.preventDefault();
			this.listEl.classList.add('is-drop');
		});
		this.listEl.addEventListener('dragleave', () => this.listEl.classList.remove('is-drop'));
		this.listEl.addEventListener('drop', ev => {
			if (!hasFiles(ev))
				return;

			ev.preventDefault();
			this.listEl.classList.remove('is-drop');
			this.handleUpload(Array.prototype.slice.call((ev.dataTransfer && ev.dataTransfer.files) || []), true);
		});

		window.addEventListener('popstate', ev => {
			this.navigate((ev.state && ev.state.path) || '/', { history: false });
		});

		const initial = new URLSearchParams(window.location.search).get('path') || '/';

		this.navigate(initial, { history: 'replace' });

		return E([
			E('link', { 'rel': 'stylesheet', 'href': CSS_URL }),
			E('h2', {}, [ _('File Manager') ]),
			E('div', { 'class': 'cbi-section fb-container' }, [
				E('div', { 'class': 'fb-pathbar' }, [ this.upBtn, this.pathInput ]),
				E('div', { 'class': 'fb-panel' }, [
					E('div', { 'class': 'fb-title' }, [ _('File List') ]),
					E('div', { 'class': 'fb-tools' }, [ this.uploadStatus, this.uploadBtn, this.fileInput ])
				]),
				this.listEl,
				E('div', { 'class': 'fb-warning' }, [
					'\u26A0\uFE0F ' + _('Upload, delete and install act directly on the system. Please be careful.')
				])
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
			this.upBtn.disabled = (path === '/');
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

	sortKey: 'name',
	sortDir: 1,
	cols: null,
	dragCol: null,

	getCols() {
		if (this.cols)
			return this.cols;

		const def = [ 'name', 'kind', 'size', 'mtime', 'mode' ];
		let saved = null;

		try { saved = JSON.parse(window.localStorage.getItem('fileman.cols')); } catch (e) { saved = null; }

		this.cols = (Array.isArray(saved) && saved.length === def.length &&
			def.every(k => saved.indexOf(k) !== -1) && saved[0] === 'name') ? saved : def;

		return this.cols;
	},

	moveCol(from, to) {
		const cols = this.getCols().slice();
		const i = cols.indexOf(from);
		const j = cols.indexOf(to);

		/* Name is pinned to the first position */
		if (i < 1 || j < 1 || i === j)
			return;

		cols.splice(i, 1);
		cols.splice(j, 0, from);
		this.cols = cols;

		try { window.localStorage.setItem('fileman.cols', JSON.stringify(cols)); } catch (e) { /* ignore */ }

		this.renderList();
	},

	setSort(key) {
		if (this.sortKey === key) {
			this.sortDir = -this.sortDir;
		}
		else {
			this.sortKey = key;
			/* size and date are most useful newest / largest first */
			this.sortDir = (key === 'mtime' || key === 'size') ? -1 : 1;
		}

		this.renderList();
	},

	kindOf(e) {
		const isLink = e.type === 'symlink';

		if (e.type === 'directory' || (isLink && e.targetType === 'directory'))
			return isLink ? _('Link to folder') : _('Folder');

		if (isLink)
			return _('Link');

		if (e.type !== 'file')
			return _('Special file');

		if (this.installerFor(e.name))
			return _('Package');

		const m = /\.([A-Za-z0-9_+-]{1,8})$/.exec(e.name);

		return m ? _('%s file').format(m[1].toUpperCase()) : _('File');
	},

	buildHead() {
		const labels = {
			name: [ _('Name'), 'fb-name' ],
			kind: [ _('Kind'), 'fb-kind' ],
			size: [ _('Size'), 'fb-size' ],
			mtime: [ _('Modified'), 'fb-date' ],
			mode: [ _('Permissions'), 'fb-perm' ]
		};

		const col = key => {
			const active = (this.sortKey === key);
			const th = E('div', {
				'class': 'th fb-sort ' + labels[key][1] + (active ? ' is-sorted' : ''),
				'role': 'button',
				'tabindex': '0',
				'draggable': key === 'name' ? null : 'true',
				'title': key === 'name' ? _('Click to sort') : _('Click to sort, drag to move'),
				'click': () => this.setSort(key),
				'keydown': ev => {
					if (ev.key === 'Enter' || ev.key === ' ') {
						ev.preventDefault();
						this.setSort(key);
					}
				},
				'dragstart': ev => {
					if (key === 'name') {
						ev.preventDefault();
						return;
					}

					this.dragCol = key;
					ev.dataTransfer.effectAllowed = 'move';
					ev.dataTransfer.setData('text/plain', key);
				},
				'dragend': () => {
					this.dragCol = null;
					Array.prototype.forEach.call(this.listEl.querySelectorAll('.is-col-target'),
						n => n.classList.remove('is-col-target'));
				},
				'dragover': ev => {
					if (!this.dragCol || this.dragCol === key || key === 'name')
						return;

					ev.preventDefault();
					th.classList.add('is-col-target');
				},
				'dragleave': () => th.classList.remove('is-col-target'),
				'drop': ev => {
					if (!this.dragCol || key === 'name')
						return;

					ev.preventDefault();
					this.moveCol(this.dragCol, key);
				}
			}, [ labels[key][0] ]);

			if (active)
				th.appendChild(E('span', { 'class': 'fb-arrow' }, [ this.sortDir > 0 ? '\u25B2' : '\u25BC' ]));

			return th;
		};

		return E('div', { 'class': 'tr table-titles fb-head' },
			this.getCols().map(col).concat([ E('div', { 'class': 'th fb-actions' }, [ _('Action') ]) ]));
	},

	renderList() {
		const isDirEntry = e => e.type === 'directory' ||
			(e.type === 'symlink' && e.targetType === 'directory');

		const key = this.sortKey;
		const dir = this.sortDir;
		const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

		/* folders stay on top when sorting by name or kind */
		/* entries shown as "-" have no size at all: they rank below a real 0 B file */
		const sizeVal = e => (isDirEntry(e) || e.size == null) ? -1 : e.size;

		const pinDirs = (key === 'name' || key === 'kind');

		const sorted = this.entries.slice().sort((a, b) => {
			if (pinDirs) {
				const grp = isDirEntry(b) - isDirEntry(a);

				if (grp)
					return grp;
			}

			let r = 0;

			if (key === 'mtime')
				r = (a.mtime || 0) - (b.mtime || 0);
			else if (key === 'size')
				r = sizeVal(a) - sizeVal(b);
			else if (key === 'kind')
				r = this.kindOf(a).localeCompare(this.kindOf(b));
			else if (key === 'mode')
				r = ((a.mode || 0) & 0o777) - ((b.mode || 0) & 0o777);
			else
				r = byName(a, b);

			return r ? r * dir : byName(a, b);
		});

		const rows = [ this.buildHead() ];

		sorted.forEach((e, i) => rows.push(this.buildRow(e, i, isDirEntry(e))));

		L.dom.content(this.listEl, E('div', { 'class': 'table cbi-section-table' }, rows));
	},

	handleDownload(full, name) {
		ui.showModal(_('Download'), [
			E('p', {}, [ _('Do u want to download %s ?').format(name) ]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, [ _('Cancel') ]),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-positive important',
					'click': () => {
						ui.hideModal();
						downloadFile(full, name);
					}
				}, [ _('Download') ])
			])
		]);
	},

	buildRow(e, idx, isDir) {
		const full = joinPath(this.cwd, e.name);
		const isLink = e.type === 'symlink';
		const isFile = e.type === 'file' || (isLink && e.targetType === 'file');
		const icon = isLink ? 'is-link' : (isDir ? 'is-dir' : (isFile && this.installerFor(e.name) ? 'is-pkg' : 'is-file'));
		const label = (isLink && e.target) ? e.name + ' -> ' + e.target : e.name;
		const clickable = isDir || isFile;

		const nameAttrs = { 'class': 'td fb-name' + (clickable ? ' is-clickable' : '') };

		if (clickable) {
			nameAttrs.click = () => {
				if (isDir)
					this.navigate(full);
				else
					this.handleDownload(full, e.name);
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

		/* shown instead of the date and size columns when the list is narrow */
		const subEl = E('div', { 'class': 'fb-sub' });
		subEl.textContent = dateEl.textContent + ((isDir || e.size == null) ? '' : '  \u00b7  ' + sizeEl.textContent);

		const kindEl = E('div', { 'class': 'td fb-kind' });
		kindEl.textContent = this.kindOf(e);

		const permEl = E('div', { 'class': 'td fb-perm' });
		permEl.textContent = modeString(e.type, e.mode);

		const cells = {
			name: E('div', nameAttrs, [ E('span', { 'class': 'fb-entry ' + icon }, [ nameEl ]), subEl ]),
			kind: kindEl,
			size: sizeEl,
			mtime: dateEl,
			mode: permEl
		};

		return E('div', { 'class': 'tr fb-row cbi-rowstyle-' + (1 + idx % 2) },
			this.getCols().map(k => cells[k]).concat([ E('div', { 'class': 'td fb-actions' }, actions) ]));
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

	handleUpload(files, confirm) {
		if (!files || !files.length || this.uploadBtn.disabled)
			return Promise.resolve();

		const existing = files
			.filter(f => this.entries.some(e => e.name === f.name))
			.map(f => f.name);

		/* files picked with the Upload button were chosen on purpose; dropped files always ask first */
		if (!existing.length && !confirm)
			return this.uploadFiles(files);

		const names = files.map(f => f.name).join(', ');

		ui.showModal(_('Upload'), [
			E('p', {}, [ existing.length
				? _('Overwrite existing file(s): %s ?').format(existing.join(', '))
				: _('Do u want to upload %s to %s ?').format(names, this.cwd) ]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, [ _('Cancel') ]),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-positive important',
					'click': () => this.uploadFiles(files)
				}, [ _('Upload') ])
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
