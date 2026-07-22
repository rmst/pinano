import { BASH_SHORTCUT_CUSTOM_TYPE } from "../session-manager/bash-shortcut-entry.js"

export const SESSION_CUSTOM_TYPE_REWIND = "rewind"
export const SESSION_CUSTOM_TYPE_BRANCH_SWITCH = "branch_switch"
export const SESSION_CUSTOM_TYPE_FILE_RESTORE = "file_restore"
export const SESSION_CUSTOM_TYPE_BASH_SHORTCUT = BASH_SHORTCUT_CUSTOM_TYPE

export const LEGACY_SESSION_CUSTOM_TYPE_WEB_REWIND = "web_rewind"
export const LEGACY_SESSION_CUSTOM_TYPE_WEB_TREE_SWITCH = "web_tree_switch"

/** @param {unknown} customType */
export function isRewindCustomType(customType) {
	return customType === SESSION_CUSTOM_TYPE_REWIND || customType === LEGACY_SESSION_CUSTOM_TYPE_WEB_REWIND
}

/** @param {unknown} customType */
export function isBranchSwitchCustomType(customType) {
	return customType === SESSION_CUSTOM_TYPE_BRANCH_SWITCH || customType === LEGACY_SESSION_CUSTOM_TYPE_WEB_TREE_SWITCH
}

/** @param {unknown} customType */
export function isSessionActivityCustomType(customType) {
	return isRewindCustomType(customType)
		|| isBranchSwitchCustomType(customType)
		|| customType === SESSION_CUSTOM_TYPE_FILE_RESTORE
		|| customType === SESSION_CUSTOM_TYPE_BASH_SHORTCUT
}
