export default function SampleDepartment() {
  return (
    <div className="space-y-6">
      <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
        <h2 className="text-xl font-semibold text-white">Sample Department</h2>
        <p className="text-slate-400 mt-2">
          This is a sample department module demonstrating the pluggable architecture.
          New departments can be added by creating files in the departments directory.
        </p>
      </div>
      <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
        <h3 className="text-lg font-medium text-white mb-4">Items</h3>
        <p className="text-slate-500">No items yet. This department is a template.</p>
      </div>
    </div>
  );
}
