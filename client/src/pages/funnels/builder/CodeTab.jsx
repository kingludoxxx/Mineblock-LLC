// PAGE BUILDER — Code tab: raw custom_css / custom_js editors (persisted via
// the existing pages PATCH) + a read-only view of the blocks JSON.
import { AlertTriangle } from 'lucide-react';

const areaCls =
  'w-full px-3 py-2 bg-bg-elevated border border-border-default rounded-md text-text-primary ' +
  'placeholder:text-text-faint focus:outline-none focus:border-border-strong font-mono text-xs leading-relaxed resize-y';

export default function CodeTab({ css, js, blocks, onChange }) {
  return (
    <div className="flex-1 min-w-0 overflow-y-auto p-5 space-y-5">
      <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-[12px] text-amber-300/90 leading-relaxed">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>
          Custom CSS/JS is injected into the PUBLIC page exactly as written — broken code here breaks the
          live page and is your own risk. The server does not rewrite it. Test with Preview before
          re-publishing.
        </span>
      </div>

      <div>
        <label className="block text-xs uppercase tracking-wider text-text-faint mb-1.5">custom_css</label>
        <textarea
          value={css}
          onChange={(e) => onChange({ custom_css: e.target.value })}
          rows={12}
          spellCheck={false}
          placeholder="/* Injected in a <style> tag after the theme CSS */"
          className={areaCls}
        />
      </div>

      <div>
        <label className="block text-xs uppercase tracking-wider text-text-faint mb-1.5">custom_js</label>
        <textarea
          value={js}
          onChange={(e) => onChange({ custom_js: e.target.value })}
          rows={12}
          spellCheck={false}
          placeholder="// Injected in a <script> tag before </body>"
          className={areaCls}
        />
      </div>

      <div>
        <label className="block text-xs uppercase tracking-wider text-text-faint mb-1.5">
          blocks (read-only — edit on the Builder tab)
        </label>
        <pre className="w-full max-h-96 overflow-auto px-3 py-2 bg-bg-elevated border border-border-subtle rounded-md text-text-muted font-mono text-[11px] leading-relaxed">
          {JSON.stringify(blocks, null, 2)}
        </pre>
      </div>
    </div>
  );
}
