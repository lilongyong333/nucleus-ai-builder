import { notFound } from "next/navigation";
import { PublishedPreview } from "@/components/published-preview";
import { getPublishedProject } from "@/lib/db";

export default async function PublishedPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await getPublishedProject(slug);
  if (!project) notFound();
  return <PublishedPreview files={project.files} title={project.title} />;
}
