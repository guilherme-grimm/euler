/**
 * Pure text motions over the rendered transcript.
 *
 * Columns are terminal cells, not code units, so wide graphemes and combining marks behave the
 * same in the cursor as they do on screen. Rows are ANSI-stripped lazily and cached: a keystroke
 * only pays for the lines it touches, not for the whole transcript.
 */

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

export interface Cursor {
	row: number;
	col: number;
}

export interface Cell {
	char: string;
	/** First cell column occupied by this grapheme. */
	cell: number;
	width: number;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Word classes, following vim's split: blank, keyword (letters/digits/_), punctuation. */
const BLANK = 0;
const WORD = 1;
const PUNCT = 2;

type Classifier = (char: string) => number;

function classOf(char: string): number {
	if (/\s/.test(char)) return BLANK;
	if (/[\p{L}\p{N}_]/u.test(char)) return WORD;
	return PUNCT;
}

/** WORD motion: only whitespace separates words. */
function bigClassOf(char: string): number {
	return /\s/.test(char) ? BLANK : WORD;
}

function stripTranscriptLine(line: string): string {
	// OSC 133 prompt markers carry no text; strip them along with styling.
	return stripTerminalSequences(line).replace(/\x1b\]133;[ABC](?:\x07|\x1b\\)/g, "");
}

export class MotionDoc {
	private readonly raw: readonly string[];
	private readonly stripped = new Map<number, string>();
	private readonly cellCache = new Map<number, Cell[]>();

	constructor(rawLines: readonly string[]) {
		this.raw = rawLines;
	}

	get lineCount(): number {
		return this.raw.length;
	}

	text(row: number): string {
		const cached = this.stripped.get(row);
		if (cached !== undefined) return cached;
		const text = stripTranscriptLine(this.raw[row] ?? "");
		this.stripped.set(row, text);
		return text;
	}

	width(row: number): number {
		const cells = this.cells(row);
		if (cells.length === 0) return 0;
		const last = cells[cells.length - 1];
		return last.cell + last.width;
	}

	cells(row: number): Cell[] {
		const cached = this.cellCache.get(row);
		if (cached) return cached;
		const cells: Cell[] = [];
		let column = 0;
		for (const { segment } of segmenter.segment(this.text(row))) {
			const width = visibleWidth(segment);
			cells.push({ char: segment, cell: column, width });
			column += width;
		}
		this.cellCache.set(row, cells);
		return cells;
	}

	/** Index into `cells(row)` holding the grapheme at a cell column (the cell containing it). */
	indexAt(row: number, col: number): number {
		const cells = this.cells(row);
		if (cells.length === 0) return 0;
		let low = 0;
		let high = cells.length - 1;
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if (cells[mid].cell <= col) low = mid;
			else high = mid - 1;
		}
		return low;
	}

	/** Last selectable cell column of a row (vim keeps the cursor on the final grapheme). */
	lastCol(row: number): number {
		const cells = this.cells(row);
		if (cells.length === 0) return 0;
		return cells[cells.length - 1].cell;
	}

	firstNonBlank(row: number): number {
		for (const cell of this.cells(row)) {
			if (classOf(cell.char) !== BLANK) return cell.cell;
		}
		return 0;
	}

	clamp(cursor: Cursor): Cursor {
		const row = Math.max(0, Math.min(this.lineCount - 1, cursor.row));
		const col = Math.max(0, Math.min(this.lastCol(row), cursor.col));
		return { row, col };
	}

	/** Text covering a cell range on one row, for copy/quote. */
	sliceText(row: number, startCol: number, endCol: number): string {
		let text = "";
		for (const cell of this.cells(row)) {
			if (cell.cell < startCol) continue;
			if (cell.cell > endCol) break;
			text += cell.char;
		}
		return text;
	}

	/** Last row that carries visible text. Transcripts end with spacer rows, which are not vim lines. */
	lastContentRow(): number {
		for (let row = this.lineCount - 1; row >= 0; row--) {
			if (this.text(row).trim().length > 0) return row;
		}
		return 0;
	}
}

function wordForward(doc: MotionDoc, cursor: Cursor, classify: Classifier): Cursor {
	let { row, col } = cursor;
	for (let guard = 0; guard < doc.lineCount + 1; guard++) {
		const cells = doc.cells(row);
		if (cells.length === 0) {
			if (row + 1 >= doc.lineCount) return cursor;
			row += 1;
			col = 0;
			continue;
		}
		let index = doc.indexAt(row, col);
		const current = classify(cells[index].char);
		if (current !== BLANK) {
			while (index < cells.length && classify(cells[index].char) === current) index += 1;
		}
		while (index < cells.length && classify(cells[index].char) === BLANK) index += 1;
		if (index >= cells.length) {
			// Crossing a line boundary lands on the first non-blank of the next line, like vim.
			if (row + 1 >= doc.lineCount) return { row, col };
			row += 1;
			return { row, col: doc.firstNonBlank(row) };
		}
		return { row, col: cells[index].cell };
	}
	return cursor;
}

function wordBackward(doc: MotionDoc, cursor: Cursor, classify: Classifier): Cursor {
	let { row, col } = cursor;
	for (let guard = 0; guard < doc.lineCount + 1; guard++) {
		const cells = doc.cells(row);
		if (cells.length === 0) {
			if (row === 0) return cursor;
			row -= 1;
			col = doc.lastCol(row);
			continue;
		}
		let index = doc.indexAt(row, col);
		if (index > 0 || classify(cells[index].char) === BLANK) {
			if (index > 0) index -= 1;
			while (index > 0 && classify(cells[index].char) === BLANK) index -= 1;
			if (classify(cells[index].char) === BLANK) continue;
			const current = classify(cells[index].char);
			while (index > 0 && classify(cells[index - 1].char) === current) index -= 1;
			return { row, col: cells[index].cell };
		}
		if (row === 0) return cursor;
		row -= 1;
		col = doc.lastCol(row);
	}
	return cursor;
}

function wordEnd(doc: MotionDoc, cursor: Cursor, classify: Classifier): Cursor {
	let { row, col } = cursor;
	for (let guard = 0; guard < doc.lineCount + 1; guard++) {
		const cells = doc.cells(row);
		if (cells.length === 0) {
			if (row + 1 >= doc.lineCount) return cursor;
			row += 1;
			col = 0;
			continue;
		}
		let index = doc.indexAt(row, col) + 1;
		while (index < cells.length && classify(cells[index].char) === BLANK) index += 1;
		if (index >= cells.length) {
			if (row + 1 >= doc.lineCount) return doc.clamp({ row, col });
			row += 1;
			col = 0;
			continue;
		}
		const current = classify(cells[index].char);
		while (index + 1 < cells.length && classify(cells[index + 1].char) === current) index += 1;
		return { row, col: cells[index].cell };
	}
	return cursor;
}

function repeat(
	doc: MotionDoc,
	cursor: Cursor,
	count: number,
	step: (doc: MotionDoc, cursor: Cursor) => Cursor,
): Cursor {
	let next = doc.clamp(cursor);
	for (let i = 0; i < count; i++) next = step(doc, next);
	return next;
}

export function moveLeft(doc: MotionDoc, cursor: Cursor, count: number): Cursor {
	let next = { ...cursor };
	for (let i = 0; i < count; i++) next = doc.clamp({ row: next.row, col: next.col - 1 });
	return next;
}

export function moveRight(doc: MotionDoc, cursor: Cursor, count: number): Cursor {
	let next = { ...cursor };
	for (let i = 0; i < count; i++) next = doc.clamp({ row: next.row, col: next.col + 1 });
	return next;
}

export function moveUp(doc: MotionDoc, cursor: Cursor, count: number, desiredCol = cursor.col): Cursor {
	return doc.clamp({ row: cursor.row - count, col: Math.min(desiredCol, doc.lastCol(cursor.row - count)) });
}

export function moveDown(doc: MotionDoc, cursor: Cursor, count: number, desiredCol = cursor.col): Cursor {
	return doc.clamp({ row: cursor.row + count, col: Math.min(desiredCol, doc.lastCol(cursor.row + count)) });
}

export function moveWordForward(doc: MotionDoc, cursor: Cursor, count: number): Cursor {
	return repeat(doc, cursor, count, (d, c) => wordForward(d, c, classOf));
}

export function moveWordBackward(doc: MotionDoc, cursor: Cursor, count: number): Cursor {
	return repeat(doc, cursor, count, (d, c) => wordBackward(d, c, classOf));
}

export function moveWordEnd(doc: MotionDoc, cursor: Cursor, count: number): Cursor {
	return repeat(doc, cursor, count, (d, c) => wordEnd(d, c, classOf));
}

export function moveBigWordForward(doc: MotionDoc, cursor: Cursor, count: number): Cursor {
	return repeat(doc, cursor, count, (d, c) => wordForward(d, c, bigClassOf));
}

export function moveBigWordBackward(doc: MotionDoc, cursor: Cursor, count: number): Cursor {
	return repeat(doc, cursor, count, (d, c) => wordBackward(d, c, bigClassOf));
}

export function moveBigWordEnd(doc: MotionDoc, cursor: Cursor, count: number): Cursor {
	return repeat(doc, cursor, count, (d, c) => wordEnd(d, c, bigClassOf));
}

export function moveLineStart(doc: MotionDoc, cursor: Cursor): Cursor {
	return doc.clamp({ row: cursor.row, col: 0 });
}

export function moveFirstNonBlank(doc: MotionDoc, cursor: Cursor): Cursor {
	return { row: cursor.row, col: doc.firstNonBlank(cursor.row) };
}

export function moveLineEnd(doc: MotionDoc, cursor: Cursor): Cursor {
	return { row: cursor.row, col: doc.lastCol(cursor.row) };
}

export function moveDocStart(doc: MotionDoc, _cursor: Cursor): Cursor {
	return { row: 0, col: doc.firstNonBlank(0) };
}

export function moveDocEnd(doc: MotionDoc, _cursor: Cursor, count = 1): Cursor {
	// `3G` jumps to line 3; a bare `G` goes to the last content line.
	const row = count > 1 ? Math.min(count - 1, doc.lineCount - 1) : doc.lastContentRow();
	return { row, col: doc.firstNonBlank(row) };
}

export function moveParagraphDown(doc: MotionDoc, cursor: Cursor, count: number): Cursor {
	let row = cursor.row;
	for (let i = 0; i < count; i++) {
		row += 1;
		while (row < doc.lineCount - 1 && doc.text(row).trim().length > 0) row += 1;
	}
	const clamped = Math.min(row, doc.lineCount - 1);
	return { row: clamped, col: doc.firstNonBlank(clamped) };
}

export function moveParagraphUp(doc: MotionDoc, cursor: Cursor, count: number): Cursor {
	let row = cursor.row;
	for (let i = 0; i < count; i++) {
		row -= 1;
		while (row > 0 && doc.text(row).trim().length > 0) row -= 1;
	}
	const clamped = Math.max(0, row);
	return { row: clamped, col: doc.firstNonBlank(clamped) };
}

export interface LineRange {
	startRow: number;
	endRow: number;
}

/** Cell range covering a visual (linewise) selection, inclusive of both endpoints' lines. */
export function linewiseRange(anchorRow: number, cursorRow: number): LineRange {
	return anchorRow <= cursorRow
		? { startRow: anchorRow, endRow: cursorRow }
		: { startRow: cursorRow, endRow: anchorRow };
}

/** Text of a character-wise selection, one entry per row, both endpoints inclusive. */
export function characterwiseText(
	doc: MotionDoc,
	anchor: Cursor,
	cursor: Cursor,
): { text: string; startRow: number; endRow: number } {
	const forward = anchor.row < cursor.row || (anchor.row === cursor.row && anchor.col <= cursor.col);
	const start = forward ? anchor : cursor;
	const end = forward ? cursor : anchor;
	const rows: string[] = [];
	for (let row = start.row; row <= end.row; row++) {
		const isFirst = row === start.row;
		const isLast = row === end.row;
		const startCol = isFirst ? start.col : 0;
		const endCol = isLast ? end.col : doc.lastCol(row);
		rows.push(doc.sliceText(row, startCol, endCol));
	}
	return { text: rows.join("\n"), startRow: start.row, endRow: end.row };
}

export function linewiseText(
	doc: MotionDoc,
	anchorRow: number,
	cursorRow: number,
): { text: string; startRow: number; endRow: number } {
	const range = linewiseRange(anchorRow, cursorRow);
	const rows: string[] = [];
	for (let row = range.startRow; row <= range.endRow; row++) rows.push(doc.text(row));
	return { text: rows.join("\n"), startRow: range.startRow, endRow: range.endRow };
}
