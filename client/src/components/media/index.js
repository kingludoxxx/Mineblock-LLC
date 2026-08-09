// Media library barrel.
//
//   import { MediaPicker } from '../../components/media';        // builder use
//   import { MediaLibraryModal } from '../../components/media';  // manage mode
//   import { AiMediaDialog } from '../../components/media';      // generate OR pick
//
// The integration contract for onSelect lives in MediaLibraryModal.jsx's file
// header — read it before wiring the picker into a block field.
//
// MediaPicker and AiMediaDialog take the SAME props (open/onClose/onSelect/
// title) and hand onSelect the SAME asset object, so a call-site can swap one
// for the other without any other change.
export { default as MediaLibraryModal } from './MediaLibraryModal';
export { default as MediaPicker } from './MediaPicker';
export { default as AiMediaDialog } from './AiMediaDialog';
