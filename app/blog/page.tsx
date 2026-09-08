import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { getAllPosts } from "@/lib/blog/posts";
import { PostCard } from "@/components/blog/PostCard";
import { JsonLd } from "@/components/seo/JsonLd";
import { breadcrumbSchema } from "@/lib/schema/builders";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Guides",
  description: `Practical guides from ${siteConfig.name} on choosing, comparing and booking.`,
  alternates: { canonical: "/blog" },
};

/**
 * The index reads the files on disk at build time. Drafts are filtered out in
 * `getAllPosts`, so an unpublished file is invisible here AND on its own URL —
 * one rule, enforced in one place.
 */
export default function BlogIndex() {
  const posts = getAllPosts();

  return (
    <>
      <JsonLd data={breadcrumbSchema([{ name: "Home", path: "/" }, { name: "Guides", path: "/blog" }])} />
      <main>
        <h1>Guides</h1>
        {posts.length === 0 ? (
          <p>There are no guides published yet.</p>
        ) : (
          posts.map((post) => <PostCard key={post.slug} post={post} />)
        )}
      </main>
    </>
  );
}
