// A `<style>` element shared by every holder of it in one document: the first
// to hold it adds it, the last to release it removes it. The count lives on the
// element itself, so a second copy of this bundle (a host that loads the page
// twice) and a second document (a page in a frame) each count their own.
const HOLDERS = "holders";

/** Hold the sheet `id` in `doc`, adding it first when no one holds it. The
 *  returned function releases this hold, once. */
export function holdSheet(doc: Document | undefined, id: string, css: string): () => void {
	if (!doc) return () => undefined;
	let style = doc.getElementById(id);
	if (style === null) {
		style = doc.createElement("style");
		style.id = id;
		style.textContent = css;
		doc.head.append(style);
	}
	style.dataset[HOLDERS] = `${Number(style.dataset[HOLDERS] ?? 0) + 1}`;
	let held = true;
	return () => {
		if (!held) return;
		held = false;
		const sheet = doc.getElementById(id);
		if (sheet === null) return;
		const left = Number(sheet.dataset[HOLDERS] ?? 1) - 1;
		if (left > 0) sheet.dataset[HOLDERS] = `${left}`;
		else sheet.remove();
	};
}
