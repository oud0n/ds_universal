package io.github.oud0n.laploupe

import android.content.Context
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import java.io.FileNotFoundException
import java.io.InputStream
import java.io.OutputStream

/**
 * 利用者が選んだフォルダ (Android の「フォルダを選ぶ」画面 = SAF の木) の読み書き (2026-10-25)。
 * 道 (例 sodegaura/20261025/20261025143810.nmea) で指す。上のフォルダへ出る名前・絶対の道は断る。
 *
 * - フォルダの中身の一覧は、少しの間 (LIST_TTL_MS) だけ覚える (たくさんのファイルを写すとき、同じフォルダを何度も読まないように)。
 *   書いた・消したら、そのフォルダの覚えを捨てる。覚えた文書が開けなければ (外で消された)、読み直してもう一度だけ試す
 * - 「無い」と「読めない」を分ける: フォルダを読めない (使えない・まだ読み込み中) ときは NativeError.io を投げる
 *   (無いと答えると、呼ぶ側が runs.json などを空から作り直して上書きしてしまうため)
 * - いくつもの流れ (保存の流れ・WebView の動画の読み込み・主スレッド) から呼ばれるので、覚えは鍵をかけて触る
 */
class SafStore(private val ctx: Context, val tree: Uri) {
    companion object {
        private const val LIST_TTL_MS = 5_000L
    }

    data class Entry(val name: String, val id: String, val size: Long, val mtimeMs: Long, val dir: Boolean)

    private class Listing(val at: Long, val items: Map<String, Entry>)

    private val resolver get() = ctx.contentResolver
    private val rootId: String = DocumentsContract.getTreeDocumentId(tree)
    private val listings = HashMap<String, Listing>()
    private val lock = Any()

    fun docUri(id: String): Uri = DocumentsContract.buildDocumentUriUsingTree(tree, id)

    /** フォルダの名前 (画面に出す) */
    fun name(): String = try {
        resolver.query(docUri(rootId), arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        } ?: "Folder"
    } catch (e: Exception) { "Folder" }

    /** 今も開けるか (許可が残っていて、フォルダがあるか) */
    fun ok(): Boolean = try {
        resolver.query(docUri(rootId), arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID), null, null, null)?.use { it.count > 0 } == true
    } catch (e: Exception) { false }

    /** フォルダの中身 (覚えがあればそれ)。読めなければ io */
    private fun children(parentId: String, fresh: Boolean = false): Map<String, Entry> {
        if (!fresh) synchronized(lock) { listings[parentId]?.takeIf { System.currentTimeMillis() - it.at < LIST_TTL_MS }?.let { return it.items } }
        val uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId)
        val cols = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED
        )
        val c = try { resolver.query(uri, cols, null, null, null) } catch (e: Exception) { throw NativeError.io("folder not readable: ${e.message}") }
            ?: throw NativeError.io("folder not readable")
        val items = LinkedHashMap<String, Entry>()
        c.use {
            // Google ドライブなどは、まだ読み込み中の一覧を返すことがある (全部でないので、無いとは言えない)
            if (it.extras?.getBoolean(DocumentsContract.EXTRA_LOADING) == true) throw NativeError.io("folder still loading")
            while (it.moveToNext()) {
                val name = it.getString(1) ?: continue
                items[name] = Entry(name, it.getString(0), if (it.isNull(3)) 0 else it.getLong(3), if (it.isNull(4)) 0 else it.getLong(4),
                    it.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR)
            }
        }
        synchronized(lock) { listings[parentId] = Listing(System.currentTimeMillis(), items) }
        return items
    }

    private fun forget(parentId: String) = synchronized(lock) { listings.remove(parentId) }

    private fun check(rel: String): List<String> {
        if (rel.isEmpty() || rel.startsWith("/") || rel.split('/').any { it.isEmpty() || it == "." || it == ".." }) throw NativeError.notFound("bad path")
        return rel.split('/')
    }

    /** その道の文書と、入っているフォルダの ID (無ければ null。読めなければ io) */
    private fun locate(rel: String, fresh: Boolean = false): Pair<Entry, String>? {
        var parent = rootId
        val parts = check(rel)
        for ((i, part) in parts.withIndex()) {
            val e = children(parent, fresh)[part] ?: return null
            if (i == parts.lastIndex) return e to parent
            if (!e.dir) return null
            parent = e.id
        }
        return null
    }

    /** その道の文書 (無ければ null。読めなければ io) */
    fun find(rel: String): Uri? = locate(rel)?.let { docUri(it.first.id) }

    fun size(rel: String): Long? = locate(rel)?.first?.size

    /** 開く (覚えた文書が外で消されていたら、読み直してもう一度だけ試す) */
    private fun <T> withDoc(rel: String, open: (Uri) -> T): T? {
        val first = locate(rel) ?: return null
        return try {
            open(docUri(first.first.id))
        } catch (e: FileNotFoundException) {
            forget(first.second)
            val again = locate(rel, fresh = true) ?: return null
            open(docUri(again.first.id))
        }
    }

    fun open(rel: String): InputStream? = withDoc(rel) { resolver.openInputStream(it) ?: throw NativeError.io("cannot open") }

    fun openFd(rel: String): ParcelFileDescriptor? = withDoc(rel) { resolver.openFileDescriptor(it, "r") ?: throw NativeError.io("cannot open") }

    /**
     * 消す。消した・もとから無い (読み直しても無い) ときは true、消せなかったときは false (読めなければ io)。
     * 一覧の覚えは古いことがあるので、読み直してから探す
     */
    fun delete(rel: String): Boolean {
        val (e, parent) = locate(rel, fresh = true) ?: return true
        val ok = try { DocumentsContract.deleteDocument(resolver, docUri(e.id)) } catch (_: FileNotFoundException) { true }
        forget(parent)
        return ok
    }

    /** 中身がまったく同じか */
    fun sameContent(rel: String, local: java.io.File): Boolean {
        val there = size(rel) ?: return false
        if (there != local.length()) return false
        val input = open(rel) ?: return false
        return input.use { a -> local.inputStream().use { b -> a.readBytes().contentEquals(b.readBytes()) } }
    }

    /** 全部のファイル (隠しファイル・exports/ を除く) */
    fun listAll(): List<Pair<String, Entry>> {
        val out = ArrayList<Pair<String, Entry>>()
        fun walk(id: String, prefix: String) {
            for (e in children(id, fresh = true).values) {
                if (e.name.startsWith(".")) continue
                val p = if (prefix.isEmpty()) e.name else "$prefix/${e.name}"
                if (e.dir) { if (p != "exports") walk(e.id, p) } else out.add(p to e)
            }
        }
        walk(rootId, "")
        return out
    }

    private fun ensureDir(parts: List<String>): String {
        var id = rootId
        for (dir in parts) {
            val e = children(id)[dir]
            id = if (e != null && e.dir) e.id else {
                val made = DocumentsContract.createDocument(resolver, docUri(id), DocumentsContract.Document.MIME_TYPE_DIR, dir)
                    ?: throw NativeError.io("cannot create $dir")
                forget(id)
                DocumentsContract.getDocumentId(made)
            }
        }
        return id
    }

    private fun mime(name: String) =
        android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"

    /**
     * 書く (無ければフォルダごと作る)。atomic なら、隠した一時ファイルに書き終えてから元のファイルと入れ替える
     * (書きかけで止まっても、元のファイルが残る。runs.json・コーナーの名前など)
     */
    fun write(rel: String, atomic: Boolean = false, writeTo: (OutputStream) -> Unit) {
        val parts = check(rel)
        val dirId = ensureDir(parts.dropLast(1))
        val name = parts.last()
        val existing = children(dirId)[name]
        if (!atomic || existing == null) {
            val uri = existing?.let { docUri(it.id) } ?: DocumentsContract.createDocument(resolver, docUri(dirId), mime(name), name)
                ?: throw NativeError.io("cannot create $name")
            forget(dirId)
            (resolver.openOutputStream(uri, "wt") ?: throw NativeError.io("cannot write $name")).use(writeTo)
            return
        }
        val tmpName = ".$name.tmp"
        children(dirId)[tmpName]?.let { DocumentsContract.deleteDocument(resolver, docUri(it.id)) }
        val tmp = DocumentsContract.createDocument(resolver, docUri(dirId), mime(name), tmpName) ?: throw NativeError.io("cannot create $tmpName")
        forget(dirId)
        try {
            (resolver.openOutputStream(tmp, "wt") ?: throw NativeError.io("cannot write $tmpName")).use(writeTo)
        } catch (e: Exception) {
            try { DocumentsContract.deleteDocument(resolver, tmp) } catch (_: Exception) {}
            throw e
        }
        // 書き終えてから入れ替える (消す → 名前を替える)
        DocumentsContract.deleteDocument(resolver, docUri(existing.id))
        DocumentsContract.renameDocument(resolver, tmp, name) ?: throw NativeError.io("cannot rename $tmpName")
        forget(dirId)
    }
}
