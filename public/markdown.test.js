import assert from "node:assert/strict";
import test from "node:test";

import { parseMarkdown, renderMarkdown, sanitizeHref, tokenizeInline } from "./markdown.js";

test("parses common chat markdown including tables", () => {
  const blocks = parseMarkdown(`
# 标题

普通 **粗体** 和 \`代码\`。

- 第一项
- [ ] 任务列表仍是文字

> 引用

| 名称 | 状态 | 数量 |
| :--- | :---: | ---: |
| A | **完成** | 2 |

\`\`\`js
const value = "<safe>";
\`\`\`
`);

  assert.deepEqual(blocks.map((block) => block.type), [
    "heading",
    "paragraph",
    "list",
    "blockquote",
    "table",
    "code",
  ]);
  assert.deepEqual(blocks[4]?.alignments, ["left", "center", "right"]);
  assert.equal(blocks[5]?.text, 'const value = "<safe>";');
});

test("keeps html as text and rejects unsafe links", () => {
  const tokens = tokenizeInline('<script>alert(1)</script> ![图](https://example.com/a.png)');
  assert.equal(tokens[0]?.type, "text");
  assert.equal(tokens[0]?.text, "<script>alert(1)</script> ");
  assert.equal(tokens[1]?.type, "imageLink");
  assert.equal(sanitizeHref("javascript:alert(1)"), null);
  assert.equal(sanitizeHref("data:text/html,test"), null);
  assert.equal(sanitizeHref("\u0001javascript:alert(1)"), null);
  assert.equal(sanitizeHref("java\tscript:alert(1)"), null);
  assert.equal(sanitizeHref("//example.com"), null);
  assert.equal(sanitizeHref("https://example.com"), "https://example.com");
});

test("leaves underscores as plain text", () => {
  const tokens = tokenizeInline("foo_bar and __not_bold__ and _not_italic_");
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0]?.type, "text");
  assert.equal(tokens[0]?.text, "foo_bar and __not_bold__ and _not_italic_");

  const starred = tokenizeInline("**bold** and *italic*");
  assert.equal(starred[0]?.type, "strong");
  assert.equal(starred[2]?.type, "emphasis");

  const blocks = parseMarkdown("___");
  assert.equal(blocks[0]?.type, "paragraph");
  assert.equal(parseMarkdown("---")[0]?.type, "rule");
  assert.equal(parseMarkdown("***")[0]?.type, "rule");
});

test("renders an icon copy button that copies the complete fenced code block", async () => {
  let copiedText = null;
  let resetFeedback = null;
  const ownerDocument = createRecordingDocument({
    async writeText(text) {
      copiedText = text;
    },
  }, (callback) => {
    resetFeedback = callback;
    return 1;
  });

  const root = renderMarkdown("```js\nconst first = 1;\nconst second = 2;\n```", ownerDocument);
  const wrapper = root.children[0];
  const button = wrapper.children[0];
  const code = wrapper.children[1].children[0];

  assert.equal(wrapper.className, "markdown-code-block");
  assert.equal(button.className, "markdown-code-copy");
  assert.equal(button.attributes["aria-label"], "复制代码");
  assert.equal(button.children[0].attributes.class, "markdown-code-copy-icon");
  assert.equal(button.children[0].children.length, 2);
  assert.equal(code.dataset.language, "js");
  await button.listeners.click();
  assert.equal(copiedText, "const first = 1;\nconst second = 2;");
  assert.equal(button.attributes["aria-label"], "已复制");
  assert.equal(button.children[0].children.length, 1);

  resetFeedback();
  assert.equal(button.attributes["aria-label"], "复制代码");
});

function createRecordingDocument(clipboard, setTimeout) {
  const createElement = (tagName) => ({
    tagName: tagName.toUpperCase(),
    attributes: {},
    children: [],
    className: "",
    dataset: {},
    listeners: {},
    style: {},
    textContent: "",
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = children;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
  });
  return {
    defaultView: {
      navigator: { clipboard },
      clearTimeout() {},
      setTimeout,
    },
    createElement,
    createElementNS(_namespace, tagName) {
      return createElement(tagName);
    },
    createTextNode(text) {
      return { nodeType: 3, textContent: text };
    },
  };
}
