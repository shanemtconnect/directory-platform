import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { getPost, getPostSlugs, formatDate, articleSchema } from "@/lib/blog/posts";
import { PostBody } from "@/components/blog/PostBody";
import { JsonLd } from "@/components/seo/JsonLd";
import { Breadcrumbs } from "@/components/seo/Breadcrumbs";
import { contentSectionLabel } from "@/lib/features/navigation";

export const revalidate = 3600;

/** Unknown slugs 404 rather than rendering an empty shell. */
export const dynamicParams = false;

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
    openGraph: {
      type: "article",
      title: post.title,
      description: post.description === "" ? undefined : post.description,
      publishedTime: post.date,
      modifiedTime: post.updated ?? post.date,
      authors: post.author ? [post.author] : undefined,
    },
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
        <article>
          <h1>{post.title}</h1>
          <p>
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
            <ul>
              {post.tags.map((tag) => (
                <li key={tag}>{tag}</li>
              ))}
            </ul>
          )}
        </article>
        <p>
          <a href="/blog">All {contentSectionLabel().toLowerCase()}</a>
        </p>
      </main>
    </>
  );
}
