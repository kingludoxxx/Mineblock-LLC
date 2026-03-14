import { Suspense, lazy, useMemo } from 'react';
import { Routes, Route } from 'react-router-dom';
import LoadingSpinner from '../shared/LoadingSpinner';

// Map department slugs to lazy-loaded components
const departmentModules = {
  sample: lazy(() => import('./modules/SampleDepartment')),
};

export default function DepartmentRouter({ slug }) {
  const DepartmentComponent = useMemo(() => departmentModules[slug], [slug]);

  if (!DepartmentComponent) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <h3 className="text-lg font-medium text-slate-300">Department not available</h3>
          <p className="text-slate-500 mt-1">This department module has not been installed yet.</p>
        </div>
      </div>
    );
  }

  return (
    <Suspense fallback={<LoadingSpinner />}>
      <DepartmentComponent />
    </Suspense>
  );
}
