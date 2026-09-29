/** Copy `text` to the clipboard. The async API needs the host's `clipboard-write`
 *  permission (the resource asks for it); a host that withholds it still gets the
 *  legacy path, which works from a click inside the frame. */
export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		// Fall through to the selection-based copy below.
	}
	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.style.position = "fixed";
	area.style.opacity = "0";
	document.body.append(area);
	area.select();
	try {
		return document.execCommand("copy");
	} finally {
		area.remove();
	}
}
