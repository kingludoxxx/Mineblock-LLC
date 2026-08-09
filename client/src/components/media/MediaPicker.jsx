// MediaPicker — the media library in SELECT mode.
//
// This is the component the funnel builder should import. It is a thin,
// deliberate wrapper: the only thing it does is pin `mode="select"` so a
// caller cannot forget it and end up with a browse-only modal that silently
// never fires onSelect.
//
// ═══════════════════════════════════════════════════════════════════════════
// CONTRACT (the full version lives in MediaLibraryModal.jsx's header)
// ═══════════════════════════════════════════════════════════════════════════
//
//   import MediaPicker from '../../components/media/MediaPicker';
//
//   const [pickerOpen, setPickerOpen] = useState(false);
//   ...
//   <MediaPicker
//     open={pickerOpen}
//     onClose={() => setPickerOpen(false)}
//     onSelect={(asset) => {
//       updateBlockProps(blockId, { src: asset.url, alt: asset.alt });
//       setPickerOpen(false);              // the picker never closes itself
//     }}
//   />
//
// onSelect(asset) where asset is:
//   { url: string (non-empty, absolute),
//     alt: string,
//     width: number|null, height: number|null,
//     id: string, mime: string, bytes: number|null,
//     source: 'upload'|'url' }
//
// Props:
//   open      boolean   (required)  caller owns visibility
//   onClose   ()=>void  (required)  fires on Escape, backdrop, X and Close
//   onSelect  (asset)=>void (required)
//   title     string    (optional)  header text, default "Choose an image"
//
// Rendering nothing when `open` is false is handled inside the modal, so
// mounting this unconditionally next to a field costs nothing.

import MediaLibraryModal from './MediaLibraryModal';

export default function MediaPicker({ open, onClose, onSelect, title }) {
  return (
    <MediaLibraryModal
      open={open}
      onClose={onClose}
      onSelect={onSelect}
      mode="select"
      title={title}
    />
  );
}
