import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { contentSectionLabel } from "@/lib/features/navigation";
import { getAllPosts } from "@/lib/blog/posts";
import { PostCard } from "@/components/blog/PostCard";
import { Breadcrumbs } from "@/components/seo/Breadcrumbs";

export const revalidate = 3600;

// One label for the section, from the contentHub flag, so the nav link, the
// breadcrumb, the H1 and the title cannot drift apart.
const SECTION = contentSectionLabel();

export const metadata: Metadata = {
  title: SECTION,
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
    <main>
      <Breadcrumbs trail={[{ name: "Home", path: "/" }, { name: SECTION, path: "/blog" }]} />
      <h1>{SECTION}</h1>
      {posts.length === 0 ? (
        <p>Nothing has been published here yet.</p>
      ) : (
        posts.map((post) => <PostCard key={post.slug} post={post} />)
      )}
    </main>
  );
}
