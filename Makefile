# Copyright (C) 2025  OneNAS-space <https://github.com/OneNAS-space/luci-app-fileman/>
#
# This is free software, licensed under the GPL-3 License
#

include $(TOPDIR)/rules.mk
include $(INCLUDE_DIR)/package.mk

PKG_NAME:=luci-app-fileman
PKG_VERSION:=1.0.2
PKG_RELEASE:=1

define Package/$(PKG_NAME)
	SECTION:=luci
	CATEGORY:=LuCI
	SUBMENU:=3. Applications
	TITLE:=LuCI File Manager (upload, download, rename, delete, install) and login info
	DEPENDS:=+luci-base
	CONFLICTS:=luci-app-advanced
	PKGARCH:=all
endef

define Package/$(PKG_NAME)/description
	A small file manager for LuCI: browse the router's file system, upload,
	download, rename and delete files, and install apk/ipk packages.
	Also includes a switch for the system summary shown at login.
endef

define Build/Compile
endef

define Package/$(PKG_NAME)/install
	$(INSTALL_DIR) $(1)/etc
	$(INSTALL_BIN) ./root/etc/sysinfo $(1)/etc/

	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./root/etc/uci-defaults/40_luci-fileman $(1)/etc/uci-defaults/

	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/luci-app-fileman.json $(1)/usr/share/luci/menu.d/

	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-fileman.json $(1)/usr/share/rpcd/acl.d/

	$(INSTALL_DIR) $(1)/www
	cp -pR ./htdocs/* $(1)/www/
endef

define Package/$(PKG_NAME)/postinst
#!/bin/sh
if [ -z "$${IPKG_INSTROOT}" ]; then
	[ -f /etc/uci-defaults/40_luci-fileman ] && sh /etc/uci-defaults/40_luci-fileman && rm -f /etc/uci-defaults/40_luci-fileman
	/etc/init.d/rpcd reload
fi
exit 0
endef

$(eval $(call BuildPackage,$(PKG_NAME)))
