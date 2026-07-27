import {
	SESSION_ATTACHMENT_KIND_IMAGE,
	SESSION_ATTACHMENT_VARIANT_DISPLAY,
	SESSION_ATTACHMENT_VARIANT_ORIGINAL,
} from "../session/attachments.js"

export function nextImageAttachmentNumber(db, sessionId, minimumNumber = 1) {
	const row = db.prepare(`
		SELECT COALESCE(MAX(number) + 1, 1) AS next
		FROM (
			SELECT number
			FROM session_attachments
			WHERE session_id = ? AND kind = ?
			UNION ALL
			SELECT mb.image_number AS number
			FROM session_entry_refs ser
			JOIN entry_message_blocks mb ON mb.global_id = ser.global_id
			WHERE ser.session_id = ?
				AND mb.type = 'image'
				AND mb.image_number IS NOT NULL
		)
	`).get(sessionId, SESSION_ATTACHMENT_KIND_IMAGE, sessionId)
	return Math.max(Number(row?.next ?? 1), minimumNumber)
}

export function insertSessionAttachmentRows(db, attachment, variants) {
	db.prepare(`
		INSERT INTO session_attachments (id, session_id, kind, number, label, detail, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run(
		attachment.id,
		attachment.sessionId,
		attachment.kind,
		attachment.number,
		attachment.label,
		attachment.detail ?? null,
		attachment.createdAt,
	)
	const insertVariant = db.prepare(`
		INSERT INTO session_attachment_variants (
			attachment_id,
			variant,
			storage_backend,
			storage_key,
			filename,
			file_path,
			mime_type,
			byte_size,
			sha256,
			width_px,
			height_px
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
	for (const variant of variants.filter(Boolean)) {
		insertVariant.run(
			attachment.id,
			variant.variant,
			variant.storageBackend,
			variant.storageKey,
			variant.filename,
			variant.filePath ?? null,
			variant.mimeType,
			variant.byteSize,
			variant.sha256,
			variant.widthPx ?? null,
			variant.heightPx ?? null,
		)
	}
}

export function attachmentImageBlockFromRows(row) {
	if (!row) return undefined
	const original = row.originalStorageKey || row.originalFilePath
		? {
			mimeType: row.originalMimeType ?? "application/octet-stream",
			...(row.originalWidthPx !== null && row.originalWidthPx !== undefined ? { widthPx: row.originalWidthPx } : {}),
			...(row.originalHeightPx !== null && row.originalHeightPx !== undefined ? { heightPx: row.originalHeightPx } : {}),
			...(row.originalStorageKey ? { storageKey: row.originalStorageKey } : {}),
			...(row.originalFilePath ? { path: row.originalFilePath } : {}),
		}
		: undefined
	return {
		type: "image",
		attachmentId: row.id,
		attachmentSessionId: row.sessionId,
		imageNumber: Number(row.number),
		mimeType: row.mimeType ?? "application/octet-stream",
		...(row.detail ? { detail: row.detail } : {}),
		...(row.widthPx !== null && row.widthPx !== undefined ? { widthPx: row.widthPx } : {}),
		...(row.heightPx !== null && row.heightPx !== undefined ? { heightPx: row.heightPx } : {}),
		...(row.storageKey ? { storageKey: row.storageKey } : {}),
		...(row.filePath ? { path: row.filePath } : {}),
		...(original ? { original } : {}),
	}
}

export function attachmentSelectSql(whereSql) {
	return `
		SELECT
			a.id,
			a.session_id AS sessionId,
			a.number,
			a.detail,
			v.mime_type AS mimeType,
			v.width_px AS widthPx,
			v.height_px AS heightPx,
			v.storage_key AS storageKey,
			v.file_path AS filePath,
			ov.mime_type AS originalMimeType,
			ov.width_px AS originalWidthPx,
			ov.height_px AS originalHeightPx,
			ov.storage_key AS originalStorageKey,
			ov.file_path AS originalFilePath
		FROM session_attachments a
		JOIN session_attachment_variants v ON v.attachment_id = a.id AND v.variant = '${SESSION_ATTACHMENT_VARIANT_DISPLAY}'
		LEFT JOIN session_attachment_variants ov ON ov.attachment_id = a.id AND ov.variant = '${SESSION_ATTACHMENT_VARIANT_ORIGINAL}'
		${whereSql}
	`
}
