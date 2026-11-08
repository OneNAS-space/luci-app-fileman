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
 * /usr/share/rpcd/acl.d/luci-app-fileman.json. No shell command lines are
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

/* ---------- File Manager's own files ---------- */

/*
 * Deleting, renaming or overwriting these from inside File Manager would saw
 * off the branch it sits on (no page, no menu entry, or no permission left to
 * repair anything). Installing a new version of the package is not affected.
 */
const OWN_DIRS = [
	'/www/luci-static/resources/view/fileman',
	'/www/luci-static/resources/fileman'
];

const OWN_FILES = [
	'/usr/share/luci/menu.d/luci-app-fileman.json',
	'/usr/share/rpcd/acl.d/luci-app-fileman.json'
];

/* one of our files, or anything inside one of our folders */
function isOwnPath(p) {
	return OWN_FILES.indexOf(p) !== -1 ||
		OWN_DIRS.some(d => p === d || p.indexOf(d + '/') === 0);
}

/* a folder that holds our files (/www, /usr, ...): removing or renaming it takes them along */
function holdsOwnPath(p) {
	const prefix = (p === '/') ? '/' : p + '/';

	return OWN_FILES.concat(OWN_DIRS).some(x => x.indexOf(prefix) === 0);
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

/* a folder, or a link that points to one: both can be opened and expanded */
function isDirEntry(e) {
	return e.type === 'directory' || (e.type === 'symlink' && e.targetType === 'directory');
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

/* the folder with every symlink resolved: a link to one of our folders must not be a way around the lock */
function realDir(path) {
	const run = bin => fs.exec(bin, [ '-f', path ]);

	return run('/usr/bin/readlink').catch(() => run('/bin/readlink')).then(
		r => normalizePath((r && r.code === 0 && String(r.stdout || '').trim()) || path),
		() => path);
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
	hostname: null,
	histIdx: 0,
	histMax: 0,
	realCwd: null,
	uploadDir: null,
	entries: [],

	/* tree view: the folders opened below the current one, and what they hold */
	expanded: {},
	subdirs: {},

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
					this.editPath(false);
				}
				else if (ev.key === 'Escape') {
					ev.preventDefault();
					ev.target.value = this.cwd || '/';
					this.editPath(false);
				}
			},
			'blur': ev => {
				if (normalizePath(ev.target.value) !== this.cwd)
					this.navigate(ev.target.value);
				this.editPath(false);
			}
		});

		/* Finder-style path bar: every folder on the way is a button, the empty
		 * space (or a double click) turns it into a text box for typing a path */
		this.crumbEl = E('div', {
			'class': 'fb-crumbs',
			'title': _('Click an empty area to type a path'),
			'click': ev => {
				if (ev.target === this.crumbEl || ev.target.classList.contains('fb-crumb-fill'))
					this.editPath(true);
			},
			'dblclick': () => this.editPath(true)
		});

		this.pathWrap = E('div', { 'class': 'fb-pathwrap' }, [ this.crumbEl, this.pathInput ]);

		/* back / forward through the folders visited, like Finder's two arrows */
		this.backBtn = E('button', {
			'class': 'cbi-button fb-nav fb-back',
			'type': 'button',
			'title': _('Back'),
			'aria-label': _('Back'),
			'disabled': 'disabled',
			'click': ev => {
				ev.preventDefault();
				if (this.histIdx > 0)
					window.history.back();
			}
		}, [ E('span', { 'class': 'fb-chevron', 'aria-hidden': 'true' }) ]);

		this.fwdBtn = E('button', {
			'class': 'cbi-button fb-nav fb-fwd',
			'type': 'button',
			'title': _('Forward'),
			'aria-label': _('Forward'),
			'disabled': 'disabled',
			'click': ev => {
				ev.preventDefault();
				if (this.histIdx < this.histMax)
					window.history.forward();
			}
		}, [ E('span', { 'class': 'fb-chevron', 'aria-hidden': 'true' }) ]);

		this.fileInput = E('input', {
			'type': 'file',
			'multiple': 'multiple',
			'style': 'display:none',
			'change': () => {
				/* the folder the picker was opened for (right-click menu), or the current one */
				const dir = this.uploadDir;

				this.uploadDir = null;
				this.handleUpload(Array.prototype.slice.call(this.fileInput.files || []), dir);
			}
		});

		this.uploadStatus = E('span', { 'class': 'fb-upload-status' });

		/* the "..." button next to the path bar: New Folder, Upload File. It doubles as the
		 * "busy" switch: while an upload runs it is disabled */
		this.uploadBtn = E('button', {
			'class': 'cbi-button fb-more-btn',   /* plain, like the two arrows: every theme paints those three alike */
			'type': 'button',
			'title': _('More actions'),
			'aria-label': _('More actions'),
			'aria-haspopup': 'menu',
			'click': ev => {
				ev.preventDefault();
				ev.stopPropagation();
				this.toggleToolMenu();
			}
		}, [ E('span', { 'class': 'fb-dots', 'aria-hidden': 'true' }) ]);

		/* drop files on a folder row to upload them into that folder, anywhere else into the current one */
		const hasFiles = ev => !!(ev.dataTransfer && Array.prototype.indexOf.call(ev.dataTransfer.types || [], 'Files') !== -1);
		const folderRowAt = ev => (ev.target && ev.target.closest) ? ev.target.closest('.fb-row[data-dropdir]') : null;

		const clearDrop = () => {
			this.listEl.classList.remove('is-drop');
			Array.prototype.forEach.call(this.listEl.querySelectorAll('.is-drop-target'),
				n => n.classList.remove('is-drop-target'));
		};

		this.listEl.addEventListener('dragover', ev => {
			if (!hasFiles(ev))
				return;

			ev.preventDefault();
			clearDrop();

			const row = folderRowAt(ev);

			if (row)
				row.classList.add('is-drop-target');
			else
				this.listEl.classList.add('is-drop');
		});
		this.listEl.addEventListener('dragleave', clearDrop);
		this.listEl.addEventListener('drop', ev => {
			if (!hasFiles(ev))
				return;

			ev.preventDefault();

			const row = folderRowAt(ev);

			clearDrop();
			this.handleUpload(Array.prototype.slice.call((ev.dataTransfer && ev.dataTransfer.files) || []),
				row ? row.getAttribute('data-dropdir') : null);
		});

		/* the menu goes away on any click elsewhere, Escape, another right-click outside the rows, scrolling or resizing */
		document.addEventListener('click', () => this.closeMenu());
		document.addEventListener('keydown', ev => {
			if (ev.key === 'Escape')
				this.closeMenu();
		});
		document.addEventListener('contextmenu', ev => {
			if (this.menuEl && !(ev.target && ev.target.closest && ev.target.closest('.fb-row')))
				this.closeMenu();
		});
		window.addEventListener('resize', () => this.closeMenu());
		window.addEventListener('scroll', () => this.closeMenu(), true);

		window.addEventListener('popstate', ev => {
			if (ev.state && typeof ev.state.i === 'number')
				this.histIdx = ev.state.i;

			this.navigate((ev.state && ev.state.path) || '/', { history: false });
		});

		/* names for the numeric owner and group ids */
		const readIds = file => fs.lines(file).then(lines => {
			const map = {};

			(lines || []).forEach(l => {
				const f = String(l).split(':');

				if (f.length >= 3 && f[0] && /^\d+$/.test(f[2]) && map[f[2]] == null)
					map[f[2]] = f[0];
			});

			return map;
		}).catch(() => ({}));

		Promise.all([ readIds('/etc/passwd'), readIds('/etc/group') ]).then(r => {
			this.idNames = { users: r[0], groups: r[1] };

			if (this.cwd != null)
				this.renderList();
		});

		/* the first crumb carries the name of this system instead of a bare "/" */
		fs.trimmed('/proc/sys/kernel/hostname').then(name => {
			if (!name)
				return;

			this.hostname = name;

			if (this.cwd != null)
				this.setPathBar(this.cwd);
		}).catch(() => null);

		const initial = new URLSearchParams(window.location.search).get('path') || '/';

		this.navigate(initial, { history: 'replace' });

		return E([
			E('link', { 'rel': 'stylesheet', 'href': CSS_URL }),
			E('h2', {}, [ _('File Manager') ]),
			E('div', { 'class': 'cbi-section fb-container' }, [
				E('div', { 'class': 'fb-pathbar' }, [ this.backBtn, this.fwdBtn, this.pathWrap, this.uploadBtn, this.fileInput ]),
				this.uploadStatus,
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

		const prev = this.cwd;

		const path = normalizePath(target);

		/*
		 * The opened folders are remembered while moving around: going into a folder and back up (or
		 * with the browser's back button) finds the tree as it was left. Only those below the new
		 * current folder are read now, the others wait until it is shown again.
		 */
		const all = Object.keys(this.expanded);
		const inside = p => (path === '/') ? (p !== '/') : (p.indexOf(path + '/') === 0);
		const reopen = all.filter(inside);
		const waiting = all.filter(p => !inside(p));

		return this.loadDir(path).then(top =>
			/* re-read the opened folders: the ones that are gone (deleted, renamed) simply close */
			Promise.all(reopen.map(p => this.loadDir(p).then(d => [ p, d ], () => null)))
				.then(subs => {
					this.expanded = {};
					this.subdirs = {};

					waiting.forEach(p => { this.expanded[p] = true; });

					subs.filter(Boolean).forEach(s => {
						this.expanded[s[0]] = true;
						this.subdirs[s[0]] = s[1];
					});

					return top;
				})
		).then(top => {
			this.cwd = path;
			this.realCwd = top.real;
			this.entries = top.entries;
			this.setPathBar(path);
			this.renderList();

			if (opts.history !== false) {
				const url = '?path=' + encodeURIComponent(path).replace(/%2F/g, '/');

				try {
					if (opts.history === 'replace') {
						const st = window.history.state;

						window.history.replaceState({ path: path, i: (st && typeof st.i === 'number') ? st.i : 0 }, '', url);
						this.histIdx = (st && typeof st.i === 'number') ? st.i : 0;
						this.histMax = this.histIdx;
					}
					else if (path !== prev) {
						window.history.pushState({ path: path, i: this.histIdx + 1 }, '', url);
						this.histIdx++;
						this.histMax = this.histIdx;
					}
				}
				catch (e) { /* ignore */ }
			}

			this.updateNav();
		}).catch(err => {
			showError(path + ': ' + errText(err));

			if (this.cwd === null && path !== '/')
				return this.navigate('/', { history: 'replace' });

			this.setPathBar(this.cwd || '/');
		});
	},

	/* ----- path bar (clickable breadcrumb + typed path) ----- */

	editPath(on) {
		this.pathWrap.classList.toggle('is-editing', !!on);

		if (on) {
			this.pathInput.value = this.cwd || '/';
			this.pathInput.focus();
			this.pathInput.select();
		}
	},

	updateNav() {
		this.backBtn.disabled = !(this.histIdx > 0);
		this.fwdBtn.disabled = !(this.histIdx < this.histMax);
	},

	setPathBar(path) {
		const parts = path.split('/').filter(Boolean);
		const items = [];
		let acc = '';

		this.pathInput.value = path;

		const crumb = (label, target, last) => E('button', {
			'type': 'button',
			'class': 'fb-crumb' + (target === '/' ? ' is-root' : '') + (last ? ' is-current' : ''),
			'data-path': target,
			'title': target,
			'aria-current': last ? 'location' : null,
			'click': ev => {
				ev.preventDefault();
				if (!last)
					this.navigate(target);
			}
		}, [ label ]);

		items.push(crumb(this.hostname || '/', '/', parts.length === 0));

		parts.forEach((name, i) => {
			acc += '/' + name;
			items.push(E('span', { 'class': 'fb-crumb-sep', 'aria-hidden': 'true' }, [ '\u203A' ]));
			items.push(crumb(name, acc, i === parts.length - 1));
		});

		items.push(E('span', { 'class': 'fb-crumb-fill' }));

		L.dom.content(this.crumbEl, items);

		/* a deep path scrolls so that the current folder stays visible */
		this.crumbEl.scrollLeft = this.crumbEl.scrollWidth;
	},

	reload() {
		return this.navigate(this.cwd || '/', { history: false });
	},

	/* ----- protection of File Manager's own files ----- */

	/* an entry, as shown and with the symlinks of its folder resolved */
	entryPaths(e) {
		return [ joinPath(e.dir, e.name), joinPath(e.realDir || e.dir, e.name) ];
	},

	/* part of File Manager, or a folder holding a part of it: no delete, no rename */
	isProtected(e) {
		return this.entryPaths(e).some(p => isOwnPath(p) || holdsOwnPath(p));
	},

	denyProtected(names) {
		showError(_('Protected: %s belongs to File Manager itself (or holds its files) and cannot be deleted, renamed or overwritten here.')
			.format(names.map(n => '"' + n + '"').join(', ')));
	},

	/* a folder's entries, each one knowing the folder it lives in (as shown and with links resolved) */
	loadDir(path) {
		return Promise.all([ this.readDir(path), realDir(path) ]).then(r => {
			r[0].forEach(e => {
				e.dir = path;
				e.realDir = r[1];
			});

			return { entries: r[0], real: r[1] };
		});
	},

	/* ----- tree view ----- */

	toggleDir(e, keepFocus) {
		const full = joinPath(e.dir, e.name);

		/* the list is rebuilt, so a keyboard user gets the focus handed back to the same triangle */
		const redraw = () => {
			this.renderList();

			if (!keepFocus)
				return;

			const t = Array.prototype.filter.call(this.listEl.querySelectorAll('.fb-twisty[data-path]'),
				n => n.getAttribute('data-path') === full)[0];

			if (t)
				t.focus();
		};

		if (this.expanded[full]) {
			/* closing a folder closes everything opened below it, too */
			Object.keys(this.expanded).forEach(p => {
				if (p === full || p.indexOf(full + '/') === 0) {
					delete this.expanded[p];
					delete this.subdirs[p];
				}
			});

			redraw();
			return Promise.resolve();
		}

		return this.loadDir(full).then(d => {
			this.subdirs[full] = d;
			this.expanded[full] = true;
			redraw();
		}).catch(err => showError(full + ': ' + errText(err)));
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
	idNames: { users: {}, groups: {} },

	getCols() {
		if (this.cols)
			return this.cols;

		const def = [ 'name', 'kind', 'size', 'mtime', 'mode', 'owner' ];
		let saved = null;

		try { saved = JSON.parse(window.localStorage.getItem('fileman.cols')); } catch (e) { saved = null; }

		/* the order the user dragged the columns into, with columns added later put at the end */
		if (Array.isArray(saved) && saved[0] === 'name') {
			const cols = saved.filter((k, i) => def.indexOf(k) !== -1 && saved.indexOf(k) === i);

			def.forEach(k => { if (cols.indexOf(k) === -1) cols.push(k); });
			this.cols = cols;
		}
		else {
			this.cols = def;
		}

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

	/* "root:root", like ls -l shows it; the number stays when /etc/passwd or /etc/group has no name for it */
	ownerOf(e) {
		if (e.uid == null && e.gid == null)
			return '-';

		const u = this.idNames.users[e.uid];
		const g = this.idNames.groups[e.gid];

		return (u != null ? u : e.uid) + ':' + (g != null ? g : e.gid);
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
			mode: [ _('Permissions'), 'fb-perm' ],
			owner: [ _('Owner/Group'), 'fb-owner' ]
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

	/* sorts one level of the tree: opened folders keep their content right below them */
	sortEntries(list) {
		const key = this.sortKey;
		const dir = this.sortDir;
		const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

		/* folders stay on top when sorting by name or kind */
		/* entries shown as "-" have no size at all: they rank below a real 0 B file */
		const sizeVal = e => (isDirEntry(e) || e.size == null) ? -1 : e.size;

		const pinDirs = (key === 'name' || key === 'kind');

		return list.slice().sort((a, b) => {
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
			else if (key === 'owner')
				r = this.ownerOf(a).localeCompare(this.ownerOf(b), undefined, { numeric: true });
			else
				r = byName(a, b);

			return r ? r * dir : byName(a, b);
		});
	},

	renderList() {
		const rows = [ this.buildHead() ];

		const walk = (list, depth) => {
			this.sortEntries(list).forEach(e => {
				rows.push(this.buildRow(e, rows.length, depth));

				const full = joinPath(e.dir, e.name);

				if (!this.expanded[full])
					return;

				const sub = this.subdirs[full];

				if (sub && sub.entries.length)
					walk(sub.entries, depth + 1);
				else
					rows.push(this.buildEmptyRow(rows.length, depth + 1));
			});
		};

		if (this.entries.length)
			walk(this.entries, 0);
		else
			rows.push(this.buildEmptyRow(rows.length, 0));

		L.dom.content(this.listEl, E('div', { 'class': 'table cbi-section-table' }, rows));
	},

	/* a muted line under an opened folder that holds nothing */
	buildEmptyRow(idx, depth) {
		const nameCell = E('div', { 'class': 'td fb-name', 'style': '--fb-indent:' + (depth * 1.4) + 'rem' }, [
			E('span', { 'class': 'fb-indent' }),
			E('span', { 'class': 'fb-twisty is-blank' }),
			E('span', { 'class': 'fb-emptytext' }, [ _('(empty)') ])
		]);

		return E('div', { 'class': 'tr fb-row fb-empty cbi-rowstyle-' + (1 + idx % 2) + (depth > 0 ? ' is-nested' : '') },
			this.getCols().map(k => k === 'name' ? nameCell : E('div', { 'class': 'td' }))
				.concat([ E('div', { 'class': 'td fb-actions' }) ]));
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

	buildRow(e, idx, depth) {
		const isDir = isDirEntry(e);
		const full = joinPath(e.dir, e.name);
		const isLink = e.type === 'symlink';
		const isFile = e.type === 'file' || (isLink && e.targetType === 'file');
		const icon = isLink ? 'is-link' : (isDir ? 'is-dir' : (isFile && this.installerFor(e.name) ? 'is-pkg' : 'is-file'));
		const label = (isLink && e.target) ? e.name + ' -> ' + e.target : e.name;
		const clickable = isDir || isFile;

		const nameAttrs = {
			'class': 'td fb-name' + (clickable ? ' is-clickable' : ''),
			'style': '--fb-indent:' + (depth * 1.4) + 'rem'
		};

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

		/* the triangle opens and closes a folder in place; clicking its name still enters it */
		const open = !!this.expanded[full];

		const twisty = isDir
			? E('span', {
				'class': 'fb-twisty' + (open ? ' is-open' : ''),
				'role': 'button',
				'tabindex': '0',
				'aria-expanded': open ? 'true' : 'false',
				'data-path': full,
				'title': open ? _('Collapse') : _('Expand'),
				'click': ev => {
					ev.stopPropagation();
					this.toggleDir(e);
				},
				'keydown': ev => {
					if (ev.key === 'Enter' || ev.key === ' ') {
						ev.preventDefault();
						ev.stopPropagation();
						this.toggleDir(e, true);
					}
				}
			})
			: E('span', { 'class': 'fb-twisty is-blank' });

		const locked = this.isProtected(e);
		const lockAttrs = locked
			? { 'disabled': 'disabled', 'title': _('Protected: File Manager needs this to run') }
			: {};

		/* what can be done with this entry: the Action column and the right-click menu both use this */
		const ops = {
			rename: { label: _('Rename'), btn: 'cbi-button-edit', locked: locked, run: () => this.handleRename(e) },
			delete: { label: _('Delete'), btn: 'cbi-button-remove', locked: locked, run: () => this.handleDelete(e) },
			install: (isFile && this.installerFor(e.name))
				? { label: _('Install'), btn: 'cbi-button-action', locked: false, run: () => this.handleInstall(e) }
				: null,

			/* menu only: pick files for this folder */
			upload: isDir
				? { label: _('Upload'), locked: false, run: () => {
					if (this.uploadBtn.disabled)
						return;

					this.uploadDir = full;
					this.fileInput.click();
				} }
				: null
		};

		const actions = [];

		[ 'rename', 'delete', 'install' ].forEach(k => {
			const o = ops[k];

			if (!o)
				return;

			if (actions.length)
				actions.push(' ');

			actions.push(E('button', Object.assign({
				'class': 'cbi-button ' + o.btn,
				'click': ev => {
					ev.preventDefault();
					o.run();
				}
			}, o.locked ? lockAttrs : {}), [ o.label ]));
		});

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

		const ownerEl = E('div', { 'class': 'td fb-owner' });
		ownerEl.textContent = this.ownerOf(e);

		const cells = {
			name: E('div', nameAttrs, [
				E('span', { 'class': 'fb-indent' }),
				twisty,
				E('span', { 'class': 'fb-entry ' + icon }, [ nameEl ]),
				subEl
			]),
			kind: kindEl,
			size: sizeEl,
			mtime: dateEl,
			mode: permEl,
			owner: ownerEl
		};

		const row = E('div', {
			'class': 'tr fb-row cbi-rowstyle-' + (1 + idx % 2) + (depth > 0 ? ' is-nested' : ''),
			'data-dropdir': isDir ? full : null,
			'tabindex': '0',
			'contextmenu': ev => this.openMenu(ev, row, ops)
		}, this.getCols().map(k => cells[k]).concat([ E('div', { 'class': 'td fb-actions' }, actions) ]));

		return row;
	},

	/* ----- right-click menu (or the menu key): Install or Upload, Rename, Delete ----- */

	closeMenu() {
		if (this.menuEl && this.menuEl.parentNode)
			this.menuEl.parentNode.removeChild(this.menuEl);

		if (this.menuRow)
			this.menuRow.classList.remove('is-menu-target');

		if (this.uploadBtn)
			this.uploadBtn.classList.remove('is-open');

		this.menuEl = null;
		this.menuRow = null;
	},

	menuItem(o, extra) {
		return E('button', {
			'class': 'fb-menu-item' + (extra || ''),
			'type': 'button',
			'role': 'menuitem',
			'disabled': o.locked ? 'disabled' : null,
			'title': o.locked ? _('Protected: File Manager needs this to run') : null,
			'click': ev2 => {
				ev2.stopPropagation();
				this.closeMenu();
				o.run();
			}
		}, [ o.label ]);
	},

	/* opts: items, themeNode (colours come from it), x / y or anchorRight, restore (focus back), row (highlighted) */
	showMenu(opts) {
		this.closeMenu();

		const menu = E('div', {
			'class': 'fb-menu',
			'role': 'menu',
			'keydown': ev2 => {
				const btns = Array.prototype.filter.call(menu.querySelectorAll('.fb-menu-item'), b => !b.disabled);
				const i = btns.indexOf(document.activeElement);

				if (ev2.key === 'ArrowDown' || ev2.key === 'ArrowUp') {
					ev2.preventDefault();

					if (btns.length)
						btns[(i + (ev2.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length].focus();
				}
				else if (ev2.key === 'Escape' || ev2.key === 'Tab') {
					ev2.preventDefault();
					this.closeMenu();
					opts.restore();
				}
			}
		}, opts.items);

		/* take the colours of the theme in use: first opaque background up the tree, and the node's text colour */
		const opaque = c => {
			const m = /^rgba?\(([^)]*)\)$/.exec(c || '');
			const parts = m ? m[1].split(/[\s,\/]+/).filter(Boolean) : [];

			return !!m && (parts.length < 4 || parseFloat(parts[3]) >= 0.95);
		};

		let bg = '#fff';

		for (let n = opts.themeNode; n && n.nodeType === 1; n = n.parentNode) {
			const c = window.getComputedStyle(n).backgroundColor;

			if (opaque(c)) {
				bg = c;
				break;
			}
		}

		menu.style.background = bg;
		menu.style.color = window.getComputedStyle(opts.themeNode).color;

		document.body.appendChild(menu);

		let x = opts.x;

		if (opts.anchorRight != null)
			x = opts.anchorRight - menu.offsetWidth;

		menu.style.left = Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4)) + 'px';
		menu.style.top = Math.max(4, Math.min(opts.y, window.innerHeight - menu.offsetHeight - 4)) + 'px';

		if (opts.row)
			opts.row.classList.add('is-menu-target');

		this.menuEl = menu;
		this.menuRow = opts.row || null;

		const first = menu.querySelector('.fb-menu-item:not([disabled])');

		if (first)
			first.focus();
	},

	openMenu(ev, row, ops) {
		ev.preventDefault();

		const items = [];

		if (ops.install)
			items.push(this.menuItem(ops.install));

		if (ops.upload)
			items.push(this.menuItem(ops.upload));

		items.push(this.menuItem(ops.rename));
		items.push(E('div', { 'class': 'fb-menu-sep', 'role': 'separator' }));
		items.push(this.menuItem(ops.delete, ' is-danger'));

		/* a menu key press has no pointer position: open it under the row instead */
		let x = ev.clientX;
		let y = ev.clientY;

		if (!x && !y) {
			const r = row.getBoundingClientRect();

			x = r.left + 24;
			y = r.bottom;
		}

		this.showMenu({ items: items, themeNode: row, x: x, y: y, row: row, restore: () => row.focus() });
	},

	/* the "..." button: New Folder, Upload File */
	toggleToolMenu() {
		const wasOpen = !!this.menuEl && this.menuEl.classList.contains('is-tools');

		this.closeMenu();

		if (wasOpen || this.uploadBtn.disabled)
			return;

		const r = this.uploadBtn.getBoundingClientRect();

		this.showMenu({
			items: [
				this.menuItem({ label: _('New Folder'), run: () => this.handleNewFolder() }),
				this.menuItem({ label: _('Upload File'), run: () => {
					if (this.uploadBtn.disabled)
						return;
					this.uploadDir = null;
					this.fileInput.click();
				} })
			],
			themeNode: this.uploadBtn.parentNode,
			anchorRight: r.right,
			y: r.bottom + 4,
			restore: () => this.uploadBtn.focus()
		});

		this.menuEl.classList.add('is-tools');
		this.uploadBtn.classList.add('is-open');
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
		const full = joinPath(e.dir, e.name);
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
		if (this.isProtected(e))
			return this.denyProtected([ e.name ]);

		const full = joinPath(e.dir, e.name);
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
		if (this.isProtected(e))
			return this.denyProtected([ e.name ]);

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

		const from = joinPath(e.dir, e.name);
		const to = joinPath(e.dir, newName);

		return fs.stat(to)
			.then(() => { throw new Error(_('"%s" already exists').format(newName)); }, () => null)
			.then(() => fs.exec('/bin/mv', [ from, to ]))
			.then(checkExec)
			.catch(err => showError(errText(err)))
			.then(() => this.reload());
	},

	/* ----- new folder ----- */

	handleNewFolder() {
		const input = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
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
			'click': () => this.doNewFolder(input.value)
		}, [ _('Create') ]);

		ui.showModal(_('New Folder'), [
			E('p', {}, [ _('Create a folder in %s. Please enter its name.').format(this.cwd) ]),
			input,
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, [ _('Cancel') ]),
				' ',
				ok
			])
		]);

		input.focus();
	},

	doNewFolder(name) {
		name = String(name || '').trim();
		ui.hideModal();

		if (!name)
			return Promise.resolve();

		if (name === '.' || name === '..' || name.indexOf('/') !== -1) {
			showError(_('Invalid file name'));
			return Promise.resolve();
		}

		const dir = this.cwd;
		const full = joinPath(dir, name);

		return fs.stat(full)
			.then(() => { throw new Error(_('"%s" already exists').format(name)); }, () => null)
			.then(() => fs.exec('/bin/mkdir', [ full ]))
			.then(checkExec)
			.catch(err => showError(errText(err)))
			.then(() => this.reload());
	},

	/* ----- upload ----- */

	/* dir: where the files go. The current folder unless they were dropped on a folder row */
	handleUpload(files, dir) {
		if (!files || !files.length || this.uploadBtn.disabled)
			return Promise.resolve();

		dir = dir || this.cwd;

		/* what the target folder already holds, to spot files that would be overwritten */
		const listing = (dir === this.cwd)
			? Promise.resolve(this.entries)
			: (this.subdirs[dir] ? Promise.resolve(this.subdirs[dir].entries) : this.loadDir(dir).then(d => d.entries));

		return listing
			.then(entries => this.confirmUpload(files, dir, entries))
			.catch(err => showError(dir + ': ' + errText(err)));
	},

	confirmUpload(files, dir, entries) {
		const existing = files
			.filter(f => entries.some(e => e.name === f.name))
			.map(f => f.name);

		/* never overwrite File Manager's own files (a missing one may still be put back) */
		const locked = entries
			.filter(e => existing.indexOf(e.name) !== -1 && this.entryPaths(e).some(isOwnPath))
			.map(e => e.name);

		if (locked.length) {
			this.fileInput.value = '';
			this.denyProtected(locked);
			return;
		}

		/* picked or dropped, uploads always ask for a final confirmation */
		const names = files.map(f => f.name).join(', ');

		ui.showModal(_('Upload'), [
			E('p', {}, [ existing.length
				? _('Overwrite existing file(s) in %s: %s ?').format(dir, existing.join(', '))
				: _('Do u want to upload %s to %s ?').format(names, dir) ]),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn cbi-button',
					'click': () => {
						/* forget the pick, so choosing the same file again fires "change" again */
						this.fileInput.value = '';
						ui.hideModal();
					}
				}, [ _('Cancel') ]),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-positive important',
					'click': () => this.uploadFiles(files, dir)
				}, [ _('Upload') ])
			])
		]);
	},

	uploadFiles(files, dir) {
		ui.hideModal();

		dir = dir || this.cwd;

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

			/* files dropped on a folder: open it, so the result is visible */
			if (dir !== this.cwd)
				this.expanded[dir] = true;

			return this.reload();
		});
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
