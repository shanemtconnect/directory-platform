import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { getPost, getPostSlugs, formatDate, articleSchema } from "@/lib/blog/posts";
import { PostBody } from "@/components/blog/PostBody";
import { JsonLd } from "@/components/seo/JsonLd";
import { Breadcrumbs } from "@/components/seo/Breadcrumbs";
import { contentSectionLabel } from "@/lib/features/navigation";
import { pageOpenGraph } from "@/lib/seo/open-graph";

export const revalidate = 3600;

/**
 * `true`, and the 404 comes from the page itself.
 *
 * `dynamicParams = false` was doing the 404 instead, and with a Redis cache
 * handler that is fatal rather than strict: the prerendered variants of a
 * dynamic route are never written to Redis during `next build` (the handler
 * refuses to touch Redis in the build phase, deliberately), so the first
 * request for a real post is a cache MISS with no fallback allowed — Next
 * logs `NoFallbackError` and serves 404 for a post that exists. Every blog post
 * in a freshly deployed container was unreachable until something else warmed
 * the cache.
 *
 * Nothing is lost by allowing the render: `getPost` returns null for any slug
 * that is not a file on disk, and the component below calls `notFound()` — so
 * an unknown slug is still a 404, just one this route decides for itself.
 */
export const dynamicParams = true;

interface Props {
  params: Promise<{ slug: string }>;
}

/**
 * Unlike the database-backed routes, every param here is genuinely known at
 * build time — the posts are files in the image — so they are enumerated
 * properly rather than returned empty.
 */
export function generateStaticParams(): { slug: string }[] {
  return getPostSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return { title: "Not found" };

  return {
    title: post.title,
    description: post.description === "" ? undefined : post.description,
    alternates: { canonical: `/blog/${post.slug}` },
    // Posts carry no image of their own yet, so pageOpenGraph's site-wide
    // card is what a share of this URL shows — better than the blank/absent
    // og:image a bare `type: "article"` override used to leave behind.
    openGraph: pageOpenGraph({
      type: "article",
      url: `/blog/${post.slug}`,
      title: post.title,
      description: post.description === "" ? undefined : post.description,
      publishedTime: post.date,
      modifiedTime: post.updated ?? post.date,
      authors: post.author ? [post.author] : undefined,
    }),
  };
}

export default async function BlogPost({ params }: Props) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();

  return (
    <>
      <JsonLd data={articleSchema(post)} />
      <main>
        <Breadcrumbs
          trail={[
            { name: "Home", path: "/" },
            { name: contentSectionLabel(), path: "/blog" },
            { name: post.title, path: `/blog/${post.slug}` },
          ]}
        />
        <article className="prose">
          <h1>{post.title}</h1>
          <p className="text-sm text-muted">
            <time dateTime={post.date}>{formatDate(post.date, siteConfig.locale)}</time>
            {post.author ? <> · {post.author}</> : null}
            {post.updated ? (
              <>
                {" "}
                · Updated{" "}
                <time dateTime={post.updated}>{formatDate(post.updated, siteConfig.locale)}</time>
              </>
            ) : null}
          </p>
          <PostBody html={post.html} />
          {post.tags.length === 0 ? null : (
            <ul className="mt-8 flex list-none flex-wrap gap-2 p-0">
              {post.tags.map((tag) => (
                <li
                  key={tag}
                  className="rounded-full border border-line bg-raised px-3 py-1 text-sm text-muted"
                >
                  {tag}
                </li>
              ))}
            </ul>
          )}
        </article>
        <p className="mt-10">
          <a href="/blog" className="btn btn-secondary">
            All {contentSectionLabel().toLowerCase()}
          </a>
        </p>
      </main>
    </>
  );
}
