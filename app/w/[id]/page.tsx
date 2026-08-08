import { Workbench } from "@/components/workbench";

export default async function WorkbenchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Workbench projectId={id} />;
}
