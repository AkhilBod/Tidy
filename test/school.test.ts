import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "tidy-home-"));
process.env.TIDY_HOME = home;
process.env.TIDY_CONFIG_DIR = join(home, ".config", "tidy");

const { addCourse, canonicalCode, codeCandidates, matchCourse } = await import("../src/classes.ts");
const { resolveTemplate } = await import("../src/config.ts");
const { assignmentId, courseworkType, inferCourse, schoolDir } = await import("../src/school.ts");
const { revisionStem } = await import("../src/util.ts");

const registry = {};
addCourse(registry, "cs 1555", { name: "Database Management Systems", institution: "University of Pittsburgh", source: "user" });
addCourse(registry, "15-213", { name: "Intro to Computer Systems", institution: "CMU", source: "user" });
addCourse(registry, "BIO101", { source: "user" });

test("course codes normalize", () => {
	assert.equal(canonicalCode("cs 1555"), "CS1555");
	assert.equal(canonicalCode("CS-1555"), "CS1555");
	assert.equal(canonicalCode("15-213"), "15-213");
	assert.equal(canonicalCode("6.006"), "6.006");
});

test("code candidates ignore camera prefixes", () => {
	assert.deepEqual(codeCandidates("IMG_3166.heic"), []);
	assert.deepEqual(codeCandidates("CS1555_HW3.pdf"), ["CS1555"]);
	assert.deepEqual(codeCandidates("15-213-assignment-2.zip"), ["15-213"]);
	assert.deepEqual(codeCandidates("econ 201 midterm notes"), ["ECON201"]);
});

test("matchCourse tolerates spelling", () => {
	assert.equal(matchCourse("CS1555_HW3.pdf", registry), "CS1555");
	assert.equal(matchCourse("cs-1555-hw3.pdf", registry), "CS1555");
	assert.equal(matchCourse("Database Management Systems syllabus.pdf", registry), "CS1555");
	assert.equal(matchCourse("15-213-assignment-2.zip", registry), "15-213");
	assert.equal(matchCourse("bio101_lab4.docx", registry), "BIO101");
	assert.equal(matchCourse("resume.pdf", registry), undefined);
	assert.equal(matchCourse("IMG_1555.jpg", registry), undefined);
});

test("coursework type and assignment id", () => {
	assert.equal(courseworkType("CS1555_HW3.pdf"), "homework");
	assert.equal(assignmentId("CS1555_HW3.pdf"), "HW3");
	assert.equal(assignmentId("Assignment 4 - graphs.pdf"), "Assignment4");
	assert.equal(courseworkType("lab3-report.docx"), "lab");
	assert.equal(assignmentId("lab3-report.docx"), "Lab3");
	assert.equal(courseworkType("midterm_study_guide.pdf"), "study_guide");
	assert.equal(assignmentId("ECON201_midterm-notes.pdf"), "Midterm");
	assert.equal(courseworkType("syllabus_fall.pdf"), "syllabus");
	assert.equal(courseworkType("lecture7-databases.pdf"), "lecture");
	assert.equal(courseworkType("starter.sql"), "starter_code");
	assert.equal(courseworkType("data.csv"), "dataset");
	assert.equal(courseworkType("random.pdf"), "unknown");
});

test("siblings resolve an ambiguous HW3.pdf", () => {
	const fact = {
		path: join(home, "Downloads", "HW3.pdf"),
		name: "HW3.pdf",
		ext: ".pdf",
		isDir: false,
		size: 10,
		sizeBucket: "<100KB",
		mtimeMs: Date.now(),
		ageDays: 3,
		root: join(home, "Downloads"),
		parent: "Downloads",
		siblings: ["cs1555-lecture7.pdf", "CS 1555 schema.sql", "resume.pdf"],
	};
	assert.deepEqual(inferCourse(fact, registry), { course: "CS1555", evidence: "siblings" });
	assert.equal(inferCourse({ ...fact, siblings: ["cs1555-lecture7.pdf", "bio101_lab4.docx"] }, registry), undefined);
	assert.equal(inferCourse({ ...fact, name: "random.pdf", siblings: ["cs1555-lecture7.pdf", "CS 1555 schema.sql"] }, registry), undefined);
});

test("school destinations follow the templates", () => {
	assert.equal(
		schoolDir({ course: "CS1555", type: "homework", assignment: "HW3" }, registry, false),
		join(home, "Documents/School/University of Pittsburgh/CS1555/Homework/HW3"),
	);
	assert.equal(schoolDir({ course: "BIO101", type: "lecture" }, registry, false), join(home, "Documents/School/BIO101/Lectures"));
	assert.equal(schoolDir({ course: "CS1555", type: "homework", assignment: "HW3" }, registry, true), join(home, "Code/school/CS1555/homework/hw3"));
	assert.equal(resolveTemplate("{screenshots}/{yyyy}-{mm}", { yyyy: "2026", mm: "06" }), join(home, "Pictures/Screenshots/2026-06"));
});

test("revision stems", () => {
	assert.equal(revisionStem("HW3-final.pdf"), "hw3");
	assert.equal(revisionStem("HW3 (2).pdf"), "hw3");
	assert.equal(revisionStem("HW3_v2.pdf"), "hw3");
	assert.equal(revisionStem("HW3-submission.pdf"), "hw3");
	assert.equal(revisionStem("resume_quant.pdf"), "resume_quant");
});
