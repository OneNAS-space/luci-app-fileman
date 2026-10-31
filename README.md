# luci-app-fileman

A small file manager for LuCI (JavaScript views, no Lua, no extra daemons).

- **System → File Manager → Files**: browse the file system, upload (multiple files, with progress),
  download, rename, delete, and install `.apk` (apk-based OpenWrt) or `.ipk` (opkg-based) packages.
- **System → File Manager → Login Info**: switch the system summary (`/etc/sysinfo`) shown at login on or off.
  It works by creating or removing `/etc/profile.d/sysinfo.sh`; `/etc/profile` is not edited.

Everything goes through rpcd's `file` plugin and `cgi-io`, authorised by
`/usr/share/rpcd/acl.d/luci-app-fileman.json`. No shell command lines are built from user input.

> This page can read, overwrite and delete anything on the router for a logged-in administrator. Be careful.

## Upgrading from luci-app-advanced

1. `apk del luci-app-advanced` (or `opkg remove luci-app-advanced`) first - both packages ship `/etc/sysinfo`.
2. Install this package. The old login-info switch (a line in `/etc/profile`) is migrated automatically.

The repository name must stay equal to the package name, the CI workflow derives `PKG_NAME` from it.

Strings are wrapped in `_()`, but no translations are shipped.

## License

MIT
