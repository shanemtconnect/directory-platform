import { describe, it, expect, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import {
  isPrivateAddress,
  assertPublicUrl,
  hasBacklink,
  checkBacklink,
  pinnedLookup,
  MAX_BODY_BYTES,
  SsrfRefusal,
  type Resolver,
} from "./backlink";

const PUBLIC: Resolver = async () => ["93.184.216.34"];
const PRIVATE: Resolver = async () => ["10.0.0.7"];
const MIXED: Resolver = async () => ["93.184.216.34", "127.0.0.1"];

describe("isPrivateAddress", () => {
  it.each([
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "127.0.0.1",
    "127.1.2.3",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    // Site-local, deprecated by RFC 3879 but still routed by stacks that
    // predate it, and still "inside" by any reading.
    "fec0::1",
    "fec0::",
    "feff:ffff::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    // The same two addresses as WHATWG URL re-serialises them. A dotted-quad
    // regex sees nothing here, which is exactly how the guard was bypassed.
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "::ffff:a00:1",
    "::7f00:1",
    "2002:7f00:1::",
    "2002:a9fe:a9fe::",
    "64:ff9b::7f00:1",
    "64:ff9b::a9fe:a9fe",
    "ff02::1",
    "fe80::1%eth0",
  ])("refuses %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "93.184.216.34",
    // Just outside 172.16/12 in both directions — the classic off-by-one.
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "2606:4700:4700::1111",
    // 6to4 and NAT64 wrapping a PUBLIC v4 address are ordinary public routes.
    "2002:808:808::",
    "64:ff9b::808:808",
    "::ffff:8.8.8.8",
  ])("allows %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  it("accepts an https URL whose host resolves to a public address", async () => {
    const url = await assertPublicUrl("https://example.com/venues", PUBLIC);
    expect(url.hostname).toBe("example.com");
  });

  it("refuses a scheme that is not http or https", async () => {
    await expect(assertPublicUrl("file:///etc/passwd", PUBLIC)).rejects.toBeInstanceOf(SsrfRefusal);
    await expect(assertPublicUrl("gopher://example.com/", PUBLIC)).rejects.toBeInstanceOf(
      SsrfRefusal,
    );
  });

  it("refuses a literal private address without asking DNS at all", async () => {
    const resolve = vi.fn<Resolver>(async () => ["93.184.216.34"]);
    await expect(assertPublicUrl("http://127.0.0.1:8080/", resolve)).rejects.toBeInstanceOf(
      SsrfRefusal,
    );
    await expect(assertPublicUrl("http://[::1]/", resolve)).rejects.toBeInstanceOf(SsrfRefusal);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses a public-looking hostname that resolves to a private address", async () => {
    // The whole point of resolving: `localtest.me` and friends are public
    // names pointing at 127.0.0.1, and a scheme check alone would let them in.
    await expect(assertPublicUrl("https://internal.example.com/", PRIVATE)).rejects.toBeInstanceOf(
      SsrfRefusal,
    );
  });

  it("refuses when ANY resolved address is private", async () => {
    // A host with one public and one private A record must not be reachable:
    // which address the fetch actually connects to is not ours to choose.
    await expect(assertPublicUrl("https://split.example.com/", MIXED)).rejects.toBeInstanceOf(
      SsrfRefusal,
    );
  });

  it("refuses a host that resolves to nothing", async () => {
    await expect(assertPublicUrl("https://nx.example.com/", async () => [])).rejects.toBeInstanceOf(
      SsrfRefusal,
    );
  });

  it("refuses when the resolver throws", async () => {
    const boom: Resolver = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertPublicUrl("https://nx.example.com/", boom)).rejects.toBeInstanceOf(
      SsrfRefusal,
    );
  });
});

describe("assertPublicUrl — IPv6 literals", () => {
  // A literal address must never reach DNS, so a resolver that throws is the
  // assertion: if any of these consults it, the test fails for that reason.
  const never: Resolver = async () => {
    throw new Error("DNS must not be consulted for a literal address");
  };

  it.each([
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[::ffff:10.0.0.1]/",
    "http://[::127.0.0.1]/",
    "http://[2002:7f00:1::]/",
    "http://[2002:a9fe:a9fe::]/",
    "http://[64:ff9b::7f00:1]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://[::1]/",
    "http://[::]/",
    "http://[fc00::1]/",
    "http://[fd00:1234::5678]/",
    "http://[fe80::1]/",
    "http://[ff02::1]/",
  ])("refuses %s", async (url) => {
    await expect(assertPublicUrl(url, never)).rejects.toBeInstanceOf(SsrfRefusal);
  });

  it.each([
    "http://[2606:4700:4700::1111]/",
    "https://[2a00:1450:4009:81f::200e]/",
    "http://[2002:808:808::]/",
    "http://[64:ff9b::808:808]/",
  ])("accepts %s", async (url) => {
    await expect(assertPublicUrl(url, never)).resolves.toBeInstanceOf(URL);
  });

  it("refuses an IPv4-mapped address that comes back from DNS", async () => {
    const mapped: Resolver = async () => ["::ffff:7f00:1"];
    await expect(assertPublicUrl("https://rebind.example/", mapped)).rejects.toBeInstanceOf(
      SsrfRefusal,
    );
  });

  it("accepts a public v6 address that comes back from DNS", async () => {
    const v6: Resolver = async () => ["2606:4700:4700::1111"];
    await expect(assertPublicUrl("https://cf.example/", v6)).resolves.toBeInstanceOf(URL);
  });
});

describe("assertPublicUrl — ports", () => {
  it.each([
    "http://example.com:22/",
    "https://example.com:5432/",
    "http://example.com:8080/",
    "http://example.com:6379/",
  ])("refuses %s", async (url) => {
    await expect(assertPublicUrl(url, PUBLIC)).rejects.toBeInstanceOf(SsrfRefusal);
  });

  it.each([
    "http://example.com/",
    "https://example.com/",
    "http://example.com:80/",
    "https://example.com:443/",
  ])("accepts %s", async (url) => {
    await expect(assertPublicUrl(url, PUBLIC)).resolves.toBeInstanceOf(URL);
  });
});

const TARGETS = ["https://dir.example/leeds/the-old-mill", "https://dir.example/"];
const PAGE = "https://client.example/about";

describe("hasBacklink", () => {
  it("counts a rel=nofollow anchor — the owner displayed the badge and linked it", () => {
    expect(
      hasBacklink(`<a href="${TARGETS[0]}" rel="nofollow noopener">us</a>`, PAGE, TARGETS),
    ).toBe(true);
  });

  it("counts the tracked snippet's anchor too, nofollow and all", () => {
    expect(
      hasBacklink(
        `<a href="${TARGETS[0]}" title="x" rel="noopener nofollow"><img src="/b.svg"></a>`,
        PAGE,
        TARGETS,
      ),
    ).toBe(true);
  });

  it("finds an anchor to the canonical listing URL", () => {
    const html = `<p>see <a href="https://dir.example/leeds/the-old-mill">our page</a></p>`;
    expect(hasBacklink(html, PAGE, TARGETS)).toBe(true);
  });

  it("ignores the badge's utm query and any fragment", () => {
    const html = `<a href="https://dir.example/leeds/the-old-mill?utm_source=badge&utm_medium=referral#top">x</a>`;
    expect(hasBacklink(html, PAGE, TARGETS)).toBe(true);
  });

  it("treats a trailing slash, a www prefix and http as the same link", () => {
    const html = `<a href="http://www.dir.example/leeds/the-old-mill/"><img src="b.svg"></a>`;
    expect(hasBacklink(html, PAGE, TARGETS)).toBe(true);
  });

  it("accepts a link to the site root", () => {
    expect(hasBacklink(`<a href="https://dir.example">home</a>`, PAGE, TARGETS)).toBe(true);
  });

  it("resolves a protocol-relative href against the page", () => {
    expect(hasBacklink(`<a href="//dir.example/leeds/the-old-mill">x</a>`, PAGE, TARGETS)).toBe(
      true,
    );
  });

  it("reads single-quoted and unquoted href attributes", () => {
    expect(hasBacklink(`<a href='https://dir.example/'>x</a>`, PAGE, TARGETS)).toBe(true);
    expect(hasBacklink(`<a href=https://dir.example/ >x</a>`, PAGE, TARGETS)).toBe(true);
  });

  it("does not count the URL appearing as plain text", () => {
    const html = `<p>Find us at https://dir.example/leeds/the-old-mill</p>`;
    expect(hasBacklink(html, PAGE, TARGETS)).toBe(false);
  });

  it("does not count an image or script src pointing at us", () => {
    // The badge IMAGE is hosted by us and appears on every embed. Counting a
    // src would mark every embed verified without a single link.
    const html = `<img src="https://dir.example/badge/abc"><script src="https://dir.example/x.js"></script>`;
    expect(hasBacklink(html, PAGE, TARGETS)).toBe(false);
  });

  it("does not count a link to a different listing", () => {
    expect(hasBacklink(`<a href="https://dir.example/leeds/other">x</a>`, PAGE, TARGETS)).toBe(
      false,
    );
  });

  it("does not count a link to a lookalike host", () => {
    expect(
      hasBacklink(`<a href="https://dir.example.evil.com/leeds/the-old-mill">x</a>`, PAGE, TARGETS),
    ).toBe(false);
  });

  it("survives a malformed href without throwing", () => {
    expect(hasBacklink(`<a href="ht tp://[[[">x</a>`, PAGE, TARGETS)).toBe(false);
  });
});

/** A fetch stand-in returning one scripted response per call. */
function scriptedFetch(responses: Response[]): typeof fetch {
  let i = 0;
  return (async () => {
    const next = responses[i++];
    if (!next) throw new Error("fetch called more times than scripted");
    return next;
  }) as typeof fetch;
}

const ok = (html: string): Response =>
  new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });

const redirect = (to: string): Response =>
  new Response(null, { status: 301, headers: { Location: to } });

describe("checkBacklink", () => {
  it("verifies a page that links to us", async () => {
    const result = await checkBacklink("https://client.example/about", TARGETS, {
      resolve: PUBLIC,
      fetchImpl: scriptedFetch([ok(`<a href="https://dir.example/leeds/the-old-mill">x</a>`)]),
    });
    expect(result).toMatchObject({ verified: true, status: 200, error: null });
  });

  it("does not verify a page with no link to us", async () => {
    const result = await checkBacklink("https://client.example/about", TARGETS, {
      resolve: PUBLIC,
      fetchImpl: scriptedFetch([ok(`<a href="https://somewhere.else/">x</a>`)]),
    });
    expect(result.verified).toBe(false);
    expect(result.error).toBe("no link to this listing found");
  });

  it("does not verify a non-2xx response", async () => {
    const result = await checkBacklink("https://client.example/about", TARGETS, {
      resolve: PUBLIC,
      fetchImpl: scriptedFetch([new Response("gone", { status: 404 })]),
    });
    expect(result).toMatchObject({ verified: false, status: 404 });
  });

  it("follows up to three redirects", async () => {
    const result = await checkBacklink("https://client.example/a", TARGETS, {
      resolve: PUBLIC,
      fetchImpl: scriptedFetch([
        redirect("https://client.example/b"),
        redirect("https://client.example/c"),
        redirect("/d"),
        ok(`<a href="https://dir.example/">x</a>`),
      ]),
    });
    expect(result.verified).toBe(true);
    expect(result.finalUrl).toBe("https://client.example/d");
  });

  it("refuses a fourth redirect rather than following it", async () => {
    const result = await checkBacklink("https://client.example/a", TARGETS, {
      resolve: PUBLIC,
      fetchImpl: scriptedFetch([
        redirect("https://client.example/b"),
        redirect("https://client.example/c"),
        redirect("https://client.example/d"),
        redirect("https://client.example/e"),
      ]),
    });
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/redirect/i);
  });

  it("applies the SSRF guard to every redirect hop, not just the first URL", async () => {
    // The classic bypass: a public URL that 302s to 169.254.169.254.
    const resolve: Resolver = async (host) =>
      host === "client.example" ? ["93.184.216.34"] : ["169.254.169.254"];
    const result = await checkBacklink("https://client.example/a", TARGETS, {
      resolve,
      fetchImpl: scriptedFetch([
        redirect("http://metadata.example/latest/meta-data/"),
        ok(`<a href="https://dir.example/">x</a>`),
      ]),
    });
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/private|refused/i);
  });

  it("refuses a private URL before it fetches anything", async () => {
    const fetchImpl = vi.fn();
    const result = await checkBacklink("http://127.0.0.1/", TARGETS, {
      resolve: PUBLIC,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.verified).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends a bot-honest user agent and does not let fetch follow redirects itself", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      return ok(`<a href="https://dir.example/">x</a>`);
    }) as unknown as typeof fetch;

    await checkBacklink("https://client.example/a", TARGETS, { resolve: PUBLIC, fetchImpl });

    const init = calls[0]!;
    expect(init.redirect).toBe("manual");
    const ua = new Headers(init.headers).get("user-agent") ?? "";
    // Identifies itself, says what it is doing and where to complain.
    expect(ua).toMatch(/bot|check/i);
    expect(ua).toContain("+http");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a network failure instead of throwing", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ETIMEDOUT");
    }) as unknown as typeof fetch;
    const result = await checkBacklink("https://client.example/a", TARGETS, {
      resolve: PUBLIC,
      fetchImpl,
    });
    expect(result).toMatchObject({ verified: false, status: null });
    expect(result.error).toContain("ETIMEDOUT");
  });

  it("stops reading a body that never ends", async () => {
    // A worker that buffers whatever a third-party site sends is one hostile
    // response away from an OOM kill.
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const result = await checkBacklink("https://client.example/a", TARGETS, {
      resolve: PUBLIC,
      fetchImpl: scriptedFetch([new Response(endless, { status: 200 })]),
    });
    expect(result.verified).toBe(false);
    expect(MAX_BODY_BYTES).toBeLessThanOrEqual(2_000_000);
  });
});

/** Calls a Node-style lookup and returns what a socket would connect to. */
function resolveVia(lookup: LookupFunction, hostname: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true }, (err, address) => {
      if (err) return reject(err);
      resolve(Array.isArray(address) ? address.map((a) => a.address) : [address]);
    });
  });
}

describe("pinnedLookup", () => {
  it("answers only with the addresses pinned for that host, in both callback shapes", async () => {
    const pins = new Map<string, string[]>([["client.example", ["93.184.216.34", "2606:4700::1"]]]);
    const lookup = pinnedLookup(pins);

    expect(await resolveVia(lookup, "client.example")).toEqual(["93.184.216.34", "2606:4700::1"]);
    expect(await resolveVia(lookup, "CLIENT.example")).toEqual(["93.184.216.34", "2606:4700::1"]);

    const single = await new Promise<[string, number | undefined]>((resolve, reject) => {
      lookup("client.example", {}, (err, address, family) => {
        if (err) return reject(err);
        resolve([address as string, family]);
      });
    });
    expect(single).toEqual(["93.184.216.34", 4]);
  });

  it("refuses a host nothing approved, so the socket cannot go anywhere the guard did not", async () => {
    const lookup = pinnedLookup(new Map([["client.example", ["93.184.216.34"]]]));
    await expect(resolveVia(lookup, "metadata.example")).rejects.toThrow(/not approved/);
    await expect(resolveVia(lookup, "client.example.evil")).rejects.toThrow(/not approved/);
  });

  it("is what the socket actually uses: a real Agent connects to the pinned address", async () => {
    // A local server, and a hostname that does not exist in any DNS. The only
    // way the request can arrive is if the connector took its address from
    // the pin — which is the whole of the DNS-rebinding defence.
    const server: Server = createServer((req, res) => {
      res.end(`host=${req.headers.host ?? ""} from=${req.socket.remoteAddress ?? ""}`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const pins = new Map<string, string[]>([["pinned.invalid", ["127.0.0.1"]]]);
    const agent: Dispatcher = new Agent({ connect: { lookup: pinnedLookup(pins) } });
    try {
      const response = await undiciFetch(`http://pinned.invalid:${port}/`, { dispatcher: agent });
      expect(await response.text()).toBe(`host=pinned.invalid:${port} from=127.0.0.1`);

      // And an unpinned name never opens a socket at all.
      await expect(undiciFetch(`http://unpinned.invalid:${port}/`, { dispatcher: agent }))
        .rejects.toThrow();
    } finally {
      await agent.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("checkBacklink — pinned connections", () => {
  /** Captures the lookup each hop's socket would use, and what it answers. */
  function capture() {
    let lookup: LookupFunction | null = null;
    const dispatcher = { kind: "fake-dispatcher", close: async () => {} } as unknown as Dispatcher;
    const factory = (fn: LookupFunction): Dispatcher => {
      lookup = fn;
      return dispatcher;
    };
    return { factory, dispatcher, resolveNow: (host: string) => resolveVia(lookup!, host) };
  }

  it("fetches through a dispatcher whose lookup answers the address the guard approved", async () => {
    const { factory, dispatcher, resolveNow } = capture();
    const inits: Array<RequestInit & { dispatcher?: Dispatcher }> = [];
    const answered: string[][] = [];
    const fetchImpl = (async (_url: string, init: RequestInit & { dispatcher?: Dispatcher }) => {
      inits.push(init);
      // What the socket would connect to AT THIS MOMENT, not later.
      answered.push(await resolveNow("client.example"));
      return ok(`<a href="https://dir.example/">x</a>`);
    }) as unknown as typeof fetch;

    const result = await checkBacklink("https://client.example/about", TARGETS, {
      resolve: async () => ["93.184.216.34"],
      fetchImpl,
      agentFactory: factory,
    });

    expect(result.verified).toBe(true);
    expect(inits[0]!.dispatcher).toBe(dispatcher);
    expect(answered).toEqual([["93.184.216.34"]]);
    // A second answer from DNS after the check would change nothing: the pin
    // is what the connector reads, not the resolver.
    expect(await resolveNow("client.example")).toEqual(["93.184.216.34"]);
  });

  it("re-resolves, re-checks and re-pins on every redirect hop", async () => {
    const { factory, resolveNow } = capture();
    const resolve: Resolver = async (host) =>
      host === "client.example" ? ["93.184.216.34"] : ["198.51.100.7"].map(() => "104.16.0.1");
    const answered: Array<Record<string, string[] | string>> = [];
    const fetchImpl = (async (url: string) => {
      const host = new URL(url).hostname;
      const other = host === "client.example" ? "cdn.example" : "client.example";
      answered.push({
        host,
        pinned: await resolveNow(host),
        // The previous hop's host is no longer pinned once we have moved on.
        stale: await resolveNow(other).catch((e: Error) => e.message),
      });
      return url.includes("cdn.example")
        ? ok(`<a href="https://dir.example/">x</a>`)
        : redirect("https://cdn.example/page");
    }) as unknown as typeof fetch;

    const result = await checkBacklink("https://client.example/a", TARGETS, {
      resolve, fetchImpl, agentFactory: factory,
    });

    expect(result.verified).toBe(true);
    expect(answered).toEqual([
      { host: "client.example", pinned: ["93.184.216.34"], stale: expect.stringMatching(/not approved/) },
      { host: "cdn.example", pinned: ["104.16.0.1"], stale: expect.stringMatching(/not approved/) },
    ]);
  });

  it("pins a literal address to itself, so no name is ever looked up for it", async () => {
    const { factory, resolveNow } = capture();
    const fetchImpl = (async () => ok(`<a href="https://dir.example/">x</a>`)) as unknown as typeof fetch;
    await checkBacklink("http://93.184.216.34/", TARGETS, {
      resolve: async () => { throw new Error("must not resolve a literal"); },
      fetchImpl,
      agentFactory: factory,
    });
    expect(await resolveNow("93.184.216.34")).toEqual(["93.184.216.34"]);
  });

  it("closes the agent it built once the check is over", async () => {
    const close = vi.fn(async () => {});
    const fetchImpl = (async () => ok(`<a href="https://dir.example/">x</a>`)) as unknown as typeof fetch;
    await checkBacklink("https://client.example/a", TARGETS, {
      resolve: PUBLIC,
      fetchImpl,
      agentFactory: () => ({ close } as unknown as Dispatcher),
    });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
