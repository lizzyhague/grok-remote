import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { t } from "./i18n.test-support.js";

const [source, styles] = await Promise.all([
  readFile(new URL("./app.js", import.meta.url), "utf8"),
  readFile(new URL("./styles.css", import.meta.url), "utf8"),
]);

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.textContent = "";
  }

  append(...children) {
    this.children.push(...children);
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }
}

test("user-input approvals use the same allow-or-decline card as other permissions", () => {
  const calls = [];
  const approvalList = new FakeElement("aside");
  const context = vm.createContext({
    elements: { approvalList },
    document: { createElement: (tagName) => new FakeElement(tagName) },
    removeApproval() {},
    t,
    answerApproval: (...args) => calls.push(args),
  });
  vm.runInContext(
    source.slice(source.indexOf("function addApproval("), source.indexOf("async function answerApproval(")),
    context,
  );

  context.addApproval({
    approvalId: "approval-1",
    kind: "user_input",
    reason: "需要人工确认",
    options: [
      { optionId: "allow-once", name: "Yes, proceed" },
      { optionId: "reject-once", name: "No" },
    ],
  });

  const card = approvalList.children[0];
  assert.equal(card.className, "permission-card");
  assert.deepEqual(card.children.map((child) => child.className), [
    "permission-card-title",
    "permission-card-body",
    "permission-card-actions",
  ]);
  assert.equal(card.children[1].children[0].textContent, "需要人工确认");
  const buttons = card.children[2].children;
  assert.deepEqual(buttons.map((button) => button.textContent), ["拒绝", "本次允许"]);

  buttons[0].listeners.get("click")();
  buttons[1].listeners.get("click")();
  assert.deepEqual(calls.map((call) => call.slice(1)), [
    ["approval-1", "decline", null],
    ["approval-1", "approve_once", null],
  ]);
});

test("permission cards match the composer width and Relayu card layout", () => {
  assert.match(styles, /\.approval-list\s*\{[^}]*max-width:\s*calc\(var\(--max-width\) \+ 2rem\);[^}]*margin:\s*0 auto 1rem;/su);
  assert.match(styles, /\.approval-list\s*\{[^}]*gap:\s*0\.5rem;[^}]*padding:\s*0 calc\(1rem \+ var\(--scrollbar-width, 0px\)\);/su);
  assert.match(styles, /\.permission-card\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto;[^}]*max-height:\s*62dvh;/su);
  assert.match(styles, /\.permission-card-body\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/su);
});
