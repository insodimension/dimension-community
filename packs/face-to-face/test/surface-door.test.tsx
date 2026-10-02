// The pinned door: one click opens the face, and it is gone while the face is up.
import { afterEach, describe, expect, test } from "bun:test";
import { FaceDoor } from "../src/surface/face-door";
import type { Intent } from "../src/surface/surface-model";
import { mountPage, unmountAll } from "./surface-dom";

afterEach(unmountAll);

describe("FaceDoor", () => {
	test("is one accessible button that mounts the face surface", async () => {
		const intents: Intent[] = [];
		const page = await mountPage(<FaceDoor activeSurface="session" onIntent={(i) => intents.push(i)} />);
		const door = page.find("button");
		expect(door?.getAttribute("aria-label")).toBe("Talk face to face");
		await page.press(door);
		expect(intents).toEqual([{ t: "mount", surface: "face" }]);
	});

	test("renders nothing while the face is already the active surface", async () => {
		const page = await mountPage(<FaceDoor activeSurface="face" onIntent={() => {}} />);
		expect(page.find("button")).toBeNull();
		expect(page.container.textContent).toBe("");
	});
});
