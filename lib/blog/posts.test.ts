import { describe, it, expect, vi } from "vitest";
import {
  escapeHtml,
  parseFrontmatter,
  renderMarkdown,
  toPost,
  getAllPosts,
  getPost,
  getPostSlugs,
  formatDate,
  articleSchema,
} from "./posts";

describe("parseFrontmatter", () => {
  it("reads keys, quoted strings, booleans and inline arrays", () => {
    const { data, body } = parseFrontmatter(
      [
        "---",
        "title: How to choose",
        'description: "A quoted: description"',
        "date: 2026-03-04",
        "author: Editorial team",
        "tags: [planning, budget]",
        "draft: false",
        "---",
        "",
        "Body text.",
      ].join("\n"),
    );

    expect(data["title"]).toBe("How to choose");
    expect(data["description"]).toBe("A quoted: description");
    expect(data["date"]).toBe("2026-03-04");
    expect(data["author"]).toBe("Editorial team");
    expect(data["tags"]).toEqual(["planning", "budget"]);
    expect(data["draft"]).toBe(false);
    expect(body).toBe("Body text.");
  });

  it("reads block-style arrays", () => {
    const { data } = parseFrontmatter("---\ntags:\n  - one\n  - two\n---\nx");
    expect(data["tags"]).toEqual(["one", "two"]);
  });

  it("returns empty data when there is no frontmatter block", () => {
    const { data, body } = parseFrontmatter("# Just markdown\n");
    expect(data).toEqual({});
    expect(body).toBe("# Just markdown");
  });

  it("does not treat a --- later in the body as frontmatter", () => {
    const { data, body } = parseFrontmatter("Intro\n\n---\ntitle: nope\n---\n");
    expect(data).toEqual({});
    expect(body).toContain("title: nope");
  });
});

describe("escapeHtml", () => {
  it("escapes every character that can create or break out of markup", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});

describe("renderMarkdown escaping", () => {
  it("neutralises a script tag in the source", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script");
    expect(html).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  });

  it("neutralises an img onerror payload", () => {
    const html = renderMarkdown(`Look: <img src=x onerror="alert(1)">`);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("cannot break out of a link href with a quote", () => {
    const html = renderMarkdown(`[x](https://a.test/" onmouseover="alert(1))`);
    expect(html).not.toContain('" onmouseover="');
    expect(html).toContain("&quot;");
  });

  it("drops a protocol-relative href, keeping the label", () => {
    // `//evil.example/x` inherits the page scheme and leaves the site — it is
    // an off-site link wearing a site-relative costume.
    expect(renderMarkdown("[go](//evil.example/x)")).toBe("<p>go</p>");
    expect(renderMarkdown("[go](/\\evil.example/x)")).toBe("<p>go</p>");
  });

  it("drops javascript: and data: hrefs, keeping the label", () => {
    expect(renderMarkdown("[click](javascript:alert1)")).toBe("<p>click</p>");
    expect(renderMarkdown("[click](data:text/html,<script>)")).not.toContain("href");
  });

  it("escapes markup inside code blocks and code spans", () => {
    expect(renderMarkdown("```\n<b>hi</b>\n```")).toBe("<pre><code>&lt;b&gt;hi&lt;/b&gt;</code></pre>");
    expect(renderMarkdown("use `<em>` here")).toBe("<p>use <code>&lt;em&gt;</code> here</p>");
  });
});

describe("renderMarkdown", () => {
  it("demotes body headings one level so a post has a single h1", () => {
    // The page renders the post title as the h1. A `#` in the body must not
    // produce a second one.
    expect(renderMarkdown("# One\n\n### Three")).toBe("<h2>One</h2>\n<h4>Three</h4>");
  });

  it("does not demote past h6", () => {
    expect(renderMarkdown("###### Six")).toBe("<h6>Six</h6>");
  });

  it("joins wrapped lines into one paragraph and separates blocks", () => {
    expect(renderMarkdown("line one\nline two\n\nsecond para")).toBe(
      "<p>line one line two</p>\n<p>second para</p>",
    );
  });

  it("renders bold, italic and links", () => {
    expect(renderMarkdown("**bold** and *italic* and [a link](/blog)")).toBe(
      '<p><strong>bold</strong> and <em>italic</em> and <a href="/blog">a link</a></p>',
    );
  });

  it("renders unordered and ordered lists", () => {
    expect(renderMarkdown("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(renderMarkdown("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  it("renders a fenced code block with its language", () => {
    expect(renderMarkdown("```ts\nconst a = 1;\n```")).toBe(
      '<pre><code class="language-ts">const a = 1;</code></pre>',
    );
  });

  it("does not treat digits in prose as a code-span placeholder", () => {
    expect(renderMarkdown("about 3 or 4 things")).toBe("<p>about 3 or 4 things</p>");
  });

  it("leaves markdown-looking characters inside a code span alone", () => {
    expect(renderMarkdown("`**not bold**`")).toBe("<p><code>**not bold**</code></p>");
  });
});

describe("toPost", () => {
  const file = (extra: string) =>
    ["---", "title: T", "date: 2026-01-02", extra, "---", "", "Body."].join("\n");

  it("builds a post and renders its body", () => {
    const post = toPost("my-slug", file("description: D"));
    expect(post?.slug).toBe("my-slug");
    expect(post?.title).toBe("T");
    expect(post?.description).toBe("D");
    expect(post?.html).toBe("<p>Body.</p>");
    expect(post?.draft).toBe(false);
    expect(post?.updated).toBeUndefined();
  });

  it("flags drafts", () => {
    expect(toPost("s", file("draft: true"))?.draft).toBe(true);
  });

  it("rejects a file with no title or a malformed date", () => {
    expect(toPost("s", "---\ndate: 2026-01-02\n---\nx")).toBeNull();
    expect(toPost("s", "---\ntitle: T\ndate: nonsense\n---\nx")).toBeNull();
    expect(toPost("s", "no frontmatter at all")).toBeNull();
  });

  it("ignores an `updated` equal to the publish date", () => {
    expect(toPost("s", file("updated: 2026-01-02"))?.updated).toBeUndefined();
    expect(toPost("s", file("updated: 2026-05-06"))?.updated).toBe("2026-05-06");
  });
});

describe("posts on disk", () => {
  const posts = getAllPosts();

  it("finds the sample posts", () => {
    expect(posts.length).toBeGreaterThanOrEqual(3);
  });

  it("returns them newest first", () => {
    const dates = posts.map((p) => p.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("never returns a draft", () => {
    expect(posts.every((p) => !p.draft)).toBe(true);
  });

  it("gives every post a title, description and rendered body", () => {
    for (const post of posts) {
      expect(post.title).not.toBe("");
      expect(post.description).not.toBe("");
      expect(post.html).toContain("<p>");
    }
  });

  it("getPostSlugs matches the published posts", () => {
    expect(getPostSlugs()).toEqual(posts.map((p) => p.slug));
  });

  it("returns no demo posts when the demo flag is unset", () => {
    // The demo directory is opt-in: a clone that never sets the flag ships an
    // empty blog rather than three articles about someone else's niche.
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", undefined);
    try {
      expect(getAllPosts()).toEqual([]);
      expect(getPostSlugs()).toEqual([]);
      const demoSlug = posts[0]?.slug;
      expect(demoSlug).toBeDefined();
      if (demoSlug) expect(getPost(demoSlug)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("getPost round-trips a real slug and rejects unknown or traversing slugs", () => {
    const first = posts[0];
    expect(first).toBeDefined();
    if (first) expect(getPost(first.slug)?.title).toBe(first.title);
    expect(getPost("does-not-exist")).toBeNull();
    expect(getPost("../../package")).toBeNull();
    expect(getPost("../lib/blog/posts")).toBeNull();
  });
});

describe("formatDate", () => {
  it("formats an ISO date in the site locale without shifting the day", () => {
    expect(formatDate("2026-01-02", "en-GB")).toBe("2 January 2026");
  });

  it("returns the input unchanged when it is not a date", () => {
    expect(formatDate("not-a-date", "en-GB")).toBe("not-a-date");
  });
});

describe("articleSchema", () => {
  const base = ["---", "title: T", "description: D", "date: 2026-01-02", "---", "", "Body."].join("\n");

  it("emits the BlogPosting fields a post genuinely has", () => {
    const post = toPost("a-slug", base.replace("date:", "author: Editorial team\ndate:"));
    expect(post).not.toBeNull();
    if (!post) return;
    const schema = articleSchema(post);
    expect(schema["@type"]).toBe("BlogPosting");
    expect(schema["headline"]).toBe("T");
    expect(schema["datePublished"]).toBe("2026-01-02");
    expect(schema["dateModified"]).toBe("2026-01-02");
    expect(schema["author"]).toEqual({ "@type": "Person", name: "Editorial team" });
  });

  it("omits author and keywords entirely when the post has none", () => {
    const post = toPost("a-slug", base);
    expect(post).not.toBeNull();
    if (!post) return;
    const schema = articleSchema(post);
    expect("author" in schema).toBe(false);
    expect("keywords" in schema).toBe(false);
  });

  it("uses the revision date for dateModified when there has been one", () => {
    const post = toPost("a-slug", base.replace("date: 2026-01-02", "date: 2026-01-02\nupdated: 2026-04-05"));
    expect(post).not.toBeNull();
    if (!post) return;
    expect(articleSchema(post)["dateModified"]).toBe("2026-04-05");
  });
});
