# luci-app-fileman

A small file manager and login-banner switch for LuCI. JavaScript views only: no Lua, no extra daemons,
no translations shipped (strings are wrapped in `_()` if you want to add your own).

## Features

### System → File Manager → Files

- Finder-style browsing, one list and no permanent tree:
  - The path bar is a **breadcrumb**: the first step is the router's host name, then one button per folder
    (`SBE1V1K › tmp › etc › passwall2`). Click any step to go there; click the empty space (or double-click) to type a path instead.
  - **Back / forward arrows** step through the folders visited. The current directory is kept in the URL, so browser
    back / forward and reloads work too.
  - Folders open **in place** with the small triangle in front of the name: the content appears indented below the folder,
    to any depth. What is open is remembered while you move around. Click the name (or double-click the row) to enter a folder.
- Desktop-style list: **Name / Kind / Size / Modified / Permissions / Owner/Group**. Rows highlight under the pointer.
  - Click a column header to sort (click again to reverse). Folders stay on top when sorting by name or kind;
    entries without a size (`-`) rank below real 0 B files when sorting by size.
  - Drag a header to reorder the columns (Name stays first). The order is remembered in the browser.
  - Kind shows Folder, Link, Package (installable `.apk` / `.ipk`) or the file extension.
  - Owner/Group is shown as names (`root:root`) looked up in `/etc/passwd` and `/etc/group`, numbers when there is no name.
- **Right-click menu** on a row (or the menu key / Shift+F10): **Rename**, **Delete**, **Install** for packages,
  **Upload** for folders. With a mouse the Action column is not needed and is hidden; on touch screens and narrow pages
  (a phone held upright) the plain list with the Action column is kept.
- The **...** button next to the path bar: **New Folder** (in the current folder) and **Upload File**.
- **Upload** from the **...** menu, from a folder's right-click menu, or by dropping files onto the list
  (onto a folder row to upload into that folder). Multiple files, progress shown. Every upload asks for a final
  confirmation, and existing files are called out before they are overwritten.
- **Download** a file by clicking its name (asks first), **Rename**, **Delete** (asks first; directories are removed recursively).
- **Install** `.apk` (apk-based OpenWrt) or `.ipk` (opkg-based) packages, with the package manager's output shown.
- **File Manager's own files are protected**: its views, stylesheet, menu entry and access rules, and the folders that
  hold them, cannot be deleted, renamed or overwritten here (symlinks into them included), so one click cannot break the page.
  This is a safety net for the interface, not a security boundary: the access rules still grant write access to the
  whole file system.
- Emoji icons instead of image files, symlinks show their target, responsive layout that follows the real content width
  (works with sidebar themes such as Argon and Bootstrap): less important columns drop out as the page gets narrower,
  no horizontal scrolling.

### System → File Manager → Login Info

- A green / red **Enabled / Disabled** badge switches the summary shown at SSH / console login on or off.
  It creates or removes `/etc/profile.d/sysinfo.sh`; `/etc/profile` is never edited.
- A terminal-style preview of the banner and the summary, following the current theme.
- `/etc/sysinfo` prints:
  - date, load, CPU, disk, memory and process count;
  - WAN and LAN interfaces with their IPv4 / IPv6 addresses (aliases and VRRP VIPs such as `br-lan:vip` included);
  - Wi-Fi: every access-point interface (any naming: `phy0-ap0`, `wl0.1-ap0`, `wlan0`, ...) with its **client count**
    and the total; client-mode (bridged / relayed uplink) interfaces are shown as `Uplink on <if>: <SSID>, <address>`
    and are not counted as access points;
  - last login: time, **user** and source address, from the dropbear log (password, public-key and blank-password logins).
    The log lives in RAM, so the information is gone after a reboot ("First login or no records").
- Not handled yet: 802.11s mesh and ad-hoc interfaces are treated like access points.

## How it works

Everything goes through rpcd's `file` plugin and `cgi-io`, authorised by
`/usr/share/rpcd/acl.d/luci-app-fileman.json`. No shell command lines are built from user input, and names coming
from the file system are always inserted as text, never as HTML.

> A logged-in administrator can read, overwrite and delete anything on the router with this page. Be careful.

## Upgrading from luci-app-advanced

1. `apk del luci-app-advanced` (or `opkg remove luci-app-advanced`) first - both packages ship `/etc/sysinfo`.
2. Install this package. The old login-info switch (a line in `/etc/profile`) is migrated automatically.

The repository name must stay equal to the package name, the CI workflow derives `PKG_NAME` from it.

## License

GPL-3.0 (see `LICENSE`).
