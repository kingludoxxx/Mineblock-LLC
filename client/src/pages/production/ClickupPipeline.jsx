import { useRef, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';

const PIPELINE_URL = 'https://mineblock-video-launcher.onrender.com';

export default function ClickupPipeline() {
  const iframeRef = useRef(null);
  const [loading, setLoading] = useState(true);

  function handleReload() {
    if (iframeRef.current) {
      setLoading(true);
      iframeRef.current.src = PIPELINE_URL;
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Thin toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-[#0f1117] flex-shrink-0">
        <span className="text-xs text-gray-500 font-medium tracking-wide uppercase">ClickUp Pipeline</span>
        <div className="flex items-center gap-2">
          <button
            onClick={handleReload}
            className="text-gray-500 hover:text-gray-300 transition p-1 rounded"
            title="Reload"
          >
            <RefreshCw size={14} />
          </button>
          <a
            href={PIPELINE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-500 hover:text-gray-300 transition p-1 rounded"
            title="Open in new tab"
          >
            <ExternalLink size={14} />
          </a>
        </div>
      </div>

      {/* Iframe fills remaining height */}
      <div className="relative flex-1">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0f1117] z-10">
            <div className="flex flex-col items-center gap-3">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-gray-500">Loading pipeline…</span>
            </div>
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={PIPELINE_URL}
          title="ClickUp Pipeline"
          className="w-full h-full border-0"
          onLoad={() => setLoading(false)}
          allow="fullscreen"
        />
      </div>
    </div>
  );
}
