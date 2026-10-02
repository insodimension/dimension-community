// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/utils/src/dom.ts @ be1cfdab27 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../../third-party/omp/LICENSE.
// Changed for the Browser pack: the entry file lives in dom/ beside its modules (import paths only).

/** Behavior-compatible reimplementation of linkedom's used surface. */

import { DOMWindow } from "./core";
import { parseDocument } from "./parser";

export {
	Attr,
	Comment,
	CSSStyleDeclaration,
	CustomEvent,
	DOMTokenList,
	DOMWindow,
	Document,
	DocumentFragment,
	Element,
	Event,
	EventTarget,
	HTMLElement,
	HTMLIFrameElement,
	HTMLMetaElement,
	HTMLTemplateElement,
	NamedNodeMap,
	Node,
	NodeType,
	SVGElement,
	serializeNode,
	Text,
} from "./core";

/** Parse HTML or XML-like markup into a lightweight window and document. */
export function parseHTML(html: string): DOMWindow {
	return new DOMWindow(parseDocument(html));
}
