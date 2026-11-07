import { describe, expect, it } from "vitest";
import {
	characterwiseText,
	linewiseText,
	MotionDoc,
	moveDocEnd,
	moveDocStart,
	moveDown,
	moveFirstNonBlank,
	moveLineEnd,
	moveLineStart,
	moveUp,
	moveWordBackward,
	moveWordEnd,
	moveWordForward,
} from "../src/modes/euler/motions.ts";

const LINES = ["the quick brown fox", "jumps over", "", "the lazy dog", "	const indented = true;"];

function doc(): MotionDoc {
	return new MotionDoc(LINES);
}

describe("euler motions", () => {
	it("moves by words, treating punctuation as its own word", () => {
		const d = doc();
		expect(moveWordForward(d, { row: 0, col: 0 }, 1)).toEqual({ row: 0, col: 4 });
		expect(moveWordForward(d, { row: 0, col: 0 }, 2)).toEqual({ row: 0, col: 10 });
		expect(moveWordForward(d, { row: 0, col: 16 }, 1)).toEqual({ row: 1, col: 0 });
		expect(moveWordEnd(d, { row: 0, col: 0 }, 1)).toEqual({ row: 0, col: 2 });
		expect(moveWordBackward(d, { row: 1, col: 0 }, 1)).toEqual({ row: 0, col: 16 });
	});

	it("clamps columns when moving between lines of different length", () => {
		const d = doc();
		const long = { row: 0, col: 18 };
		expect(moveDown(d, long, 1, long.col)).toEqual({ row: 1, col: 9 });
		expect(moveUp(d, { row: 1, col: 10 }, 1, 10)).toEqual({ row: 0, col: 10 });
	});

	it("treats empty lines as clamps, not skips", () => {
		const d = doc();
		expect(moveDown(d, { row: 1, col: 3 }, 1, 3)).toEqual({ row: 2, col: 0 });
		expect(moveDown(d, { row: 2, col: 0 }, 1, 0)).toEqual({ row: 3, col: 0 });
	});

	it("honours document and line boundaries", () => {
		const d = doc();
		expect(moveDocStart(d, { row: 3, col: 4 })).toEqual({ row: 0, col: 0 });
		expect(moveDocEnd(d, { row: 0, col: 0 }).row).toBe(4);
		expect(moveLineStart(d, { row: 0, col: 9 })).toEqual({ row: 0, col: 0 });
		expect(moveLineEnd(d, { row: 0, col: 0 })).toEqual({ row: 0, col: 18 });
		expect(moveFirstNonBlank(new MotionDoc(["    indented"]), { row: 0, col: 9 })).toEqual({ row: 0, col: 4 });
	});

	it("extracts characterwise and linewise selections", () => {
		const d = doc();
		expect(characterwiseText(d, { row: 0, col: 4 }, { row: 0, col: 8 }).text).toBe("quick");
		expect(characterwiseText(d, { row: 0, col: 16 }, { row: 1, col: 4 }).text).toBe("fox\njumps");
		expect(characterwiseText(d, { row: 1, col: 4 }, { row: 0, col: 16 }).text).toBe("fox\njumps");
		expect(linewiseText(d, 0, 1).text).toBe("the quick brown fox\njumps over");
		expect(linewiseText(d, 1, 0).text).toBe("the quick brown fox\njumps over");
	});

	it("measures columns in cells, not code units", () => {
		const d = new MotionDoc(["日本語 abc"]);
		expect(d.width(0)).toBe(10);
		expect(d.lastCol(0)).toBe(9);
		expect(moveWordForward(d, { row: 0, col: 0 }, 1)).toEqual({ row: 0, col: 7 });
		expect(d.sliceText(0, 0, 8)).toBe("日本語 ab");
	});
});
