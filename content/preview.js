/* global Zotero, ZotPoPI18N */
/* Uses Zotero's installed PDF renderer; it never creates a library item. */
var ZotPoPPreview = (function () {
	"use strict";
	const PDF_ROOT = "resource://zotero/reader/pdf/";
	const MAX_BYTES = 50 * 1024 * 1024;
	const aborted = () => Object.assign(new Error("Preview cancelled"), { name: "AbortError" });

	function safeURL(value) {
		try {
			let url = new URL(String(value || ""));
			return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
		}
		catch (_) { return null; }
	}

	function candidates(record) {
		let urls = [...(record.pdfUrls || []), record.pdfUrl];
		if (/^PMC\d+$/i.test(record.pmcid || "")) urls.push(`https://europepmc.org/articles/${record.pmcid}?pdf=render`);
		if (/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i.test(record.arxiv || "")) urls.push("https://arxiv.org/pdf/" + record.arxiv);
		return [...new Set(urls.map(safeURL).filter(Boolean))];
	}

	function originalURL(record) {
		let doi = String(record.doi || "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim();
		return safeURL(record.url) || (/^10\.\d{4,9}\/\S+$/.test(doi) ? safeURL("https://doi.org/" + doi) : null)
			|| candidates(record)[0] || null;
	}

	function pdfBytes(value) {
		let bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
		if (bytes.byteLength > MAX_BYTES) throw Object.assign(new Error("PDF is too large for preview"), { name: "PreviewSizeError" });
		let header = String.fromCharCode(...bytes.subarray(0, 1024));
		if (!header.includes("%PDF-")) throw Object.assign(new Error("The link did not return a PDF"), { name: "NotPDFError" });
		return bytes;
	}

	function createManager(openWindow) {
		let previewWindow = null, payload, lastSignature;
		let signature = record => JSON.stringify([record.key || record.doi || record.title, record.title, candidates(record), originalURL(record)]);
		function update(record, force = false) {
			if (!record || !previewWindow || previewWindow.closed) return;
			let next = signature(record);
			if (!force && next === lastSignature) return;
			lastSignature = next;
			payload.record = record;
			previewWindow.ZotPoPPreviewWindow?.showRecord(record);
		}
		return {
			open(record, options = {}) {
				if (!record) return null;
				if (!previewWindow || previewWindow.closed) {
					payload = { record, ...options };
					lastSignature = signature(record);
					previewWindow = openWindow(payload);
				}
				else update(record, true);
				previewWindow.focus();
				return previewWindow;
			},
			update,
			close() {
				if (previewWindow && !previewWindow.closed) previewWindow.close();
				previewWindow = null;
			}
		};
	}

	function createController({ fetchPDF, renderPDF, onState }) {
		let version = 0, controller;
		return {
			async showRecord(record) {
				controller?.abort();
				controller = new AbortController();
				let signal = controller.signal, current = ++version;
				let active = () => current === version && !signal.aborted;
				let info = { title: record.title || "", originalURL: originalURL(record) };
				let urls = candidates(record);
				onState({ ...info, status: urls.length ? "loading" : "unavailable" });
				let lastError;
				for (let url of urls) {
					try {
						let bytes = pdfBytes(await fetchPDF(url, signal));
						if (!active()) return;
						let rendered = await renderPDF(bytes, signal);
						if (!active()) return;
						onState({ ...info, ...rendered, status: "ready", url });
						return;
					}
					catch (e) {
						if (!active() || e.name === "AbortError") return;
						lastError = e;
					}
				}
				if (urls.length && active()) onState({ ...info, status: lastError?.name === "NotPDFError" ? "unavailable" : "error", error: lastError });
			},
			close() { version++; controller?.abort(); }
		};
	}

	async function fetchPDF(url, signal, zotero) {
		if (!safeURL(url)) throw new Error("Unsupported preview URL");
		if (signal.aborted) throw aborted();
		let cancel;
		let onAbort = () => cancel?.();
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			let xhr = await zotero.HTTP.request("GET", url, {
				responseType: "arraybuffer", timeout: 45000, errorDelayMax: 0,
				headers: { Accept: "application/pdf" },
				cancellerReceiver: fn => { cancel = fn; if (signal.aborted) fn(); }
			});
			if (signal.aborted) throw aborted();
			if (xhr.responseURL && !safeURL(xhr.responseURL)) throw new Error("Unsupported preview redirect");
			return pdfBytes(xhr.response);
		}
		catch (e) { if (signal.aborted) throw aborted(); throw e; }
		finally { signal.removeEventListener("abort", onAbort); }
	}

	function createRenderer({ getLibrary, createCanvas, width, pixelRatio }) {
		return async function renderPDF(bytes, signal) {
			let library = await getLibrary();
			if (signal.aborted) throw aborted();
			library.GlobalWorkerOptions.workerSrc = PDF_ROOT + "build/pdf.worker.mjs";
			let loadingTask = library.getDocument({
				data: bytes, isEvalSupported: false, enableXfa: false,
				cMapUrl: PDF_ROOT + "web/cmaps/", cMapPacked: true,
				standardFontDataUrl: PDF_ROOT + "web/standard_fonts/",
				wasmUrl: PDF_ROOT + "web/wasm/"
			});
			let renderTask, destroyed;
			let destroy = () => destroyed || (destroyed = loadingTask.destroy());
			let onAbort = () => { renderTask?.cancel(); destroy().catch(() => {}); };
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			try {
				let pdf = await loadingTask.promise;
				if (signal.aborted) throw aborted();
				let page = await pdf.getPage(1);
				if (signal.aborted) throw aborted();
				let base = page.getViewport({ scale: 1 });
				if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || base.width <= 0 || base.height <= 0) throw new Error("Invalid PDF page dimensions");
				let cssWidth = Math.max(280, Math.min(1400, width()));
				let ratio = Math.min(2, Math.max(1, pixelRatio()));
				let scale = Math.min(cssWidth / base.width * ratio, 8000 / base.height, Math.sqrt(16e6 / (base.width * base.height)));
				let viewport = page.getViewport({ scale });
				let canvas = createCanvas();
				canvas.width = Math.ceil(viewport.width);
				canvas.height = Math.ceil(viewport.height);
				canvas.style.width = `${Math.min(cssWidth, viewport.width / ratio)}px`;
				canvas.style.maxWidth = "100%";
				canvas.style.height = "auto";
				renderTask = page.render({ canvasContext: canvas.getContext("2d"), viewport });
				await renderTask.promise;
				if (signal.aborted) throw aborted();
				return { canvas, pageCount: pdf.numPages };
			}
			catch (e) { if (signal.aborted) throw aborted(); throw e; }
			finally {
				signal.removeEventListener("abort", onAbort);
				await destroy();
			}
		};
	}

	function initWindow(win) {
		let args = win.arguments?.[0]?.wrappedJSObject || win.arguments?.[0] || {};
		let zotero = args.Zotero || win.Zotero;
		let t = ZotPoPI18N.make(args.language || "en"), doc = win.document;
		ZotPoPI18N.apply(doc, t);
		doc.documentElement.setAttribute("lang", t.locale);
		let $ = id => doc.getElementById(id), currentURL = null, currentRecord = args.record;
		let libraryPromise;
		let renderer = createRenderer({
			getLibrary: () => libraryPromise || (libraryPromise = import("resource://zotero/reader/pdf/build/pdf.mjs")),
			createCanvas: () => doc.createElement("canvas"),
			width: () => $("preview-page").clientWidth - 40,
			pixelRatio: () => win.devicePixelRatio || 1
		});
		let controller = createController({
			fetchPDF: (url, signal) => fetchPDF(url, signal, zotero), renderPDF: renderer,
			onState(state) {
				doc.title = `${t("previewTitle")} — ${state.title}`;
				$("preview-title").textContent = state.title;
				currentURL = state.originalURL;
				$("preview-original").disabled = !currentURL;
				$("preview-retry").hidden = state.status !== "error";
				$("preview-page").replaceChildren();
				$("preview-message").hidden = state.status === "ready";
				$("preview-status").textContent = state.status === "ready" ? t("previewPageCount", state.pageCount) : t("previewTitle");
				if (state.status === "ready") {
					state.canvas.setAttribute("role", "img");
					state.canvas.setAttribute("aria-label", `${t("previewPageOne")} — ${state.title}`);
					$("preview-page").appendChild(state.canvas);
					$("preview-page").scrollTop = 0;
				}
				else {
					let key = state.status === "loading" ? "previewLoading" : state.status === "unavailable" ? "previewUnavailable"
						: state.error?.name === "PreviewSizeError" ? "previewTooLarge" : "previewFailed";
					$("preview-message").textContent = t(key);
				}
			}
		});
		win.ZotPoPPreviewWindow = { showRecord(record) { currentRecord = record; return controller.showRecord(record); } };
		$("preview-original").addEventListener("click", () => { if (safeURL(currentURL)) zotero.launchURL(currentURL); });
		$("preview-retry").addEventListener("click", () => controller.showRecord(currentRecord));
		win.addEventListener("keydown", e => { if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w")) win.close(); });
		win.addEventListener("unload", () => controller.close(), { once: true });
		if (currentRecord) controller.showRecord(currentRecord);
	}

	return { safeURL, candidates, originalURL, pdfBytes, createManager, createController, createRenderer, fetchPDF, initWindow };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPPreview;
else if (typeof window !== "undefined" && window.document.documentElement.getAttribute("windowtype") === "zotpop:preview") {
	window.addEventListener("DOMContentLoaded", () => ZotPoPPreview.initWindow(window), { once: true });
}
