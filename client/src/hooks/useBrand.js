// W8a — the runtime brand, as React state.
//
// config/brand.js exports LIVE BINDINGS (`export let BRAND_*`) that the module
// rewrites when GET /api/v1/brand answers. A component that reads the binding
// directly shows whatever the binding held at its last render, and React has no
// reason to render it again — so before this hook the shell painted the
// build-time brand and only corrected itself if something ELSE re-rendered it.
// That was invisible while the build-time default was a real store's logo, and
// it stops being invisible the moment the default is "no logo at all".
//
// One subscription per component, torn down on unmount. `onBrand` replays the
// current value to a late subscriber, so a component mounted after the fetch
// settles never waits for a second answer.
import { useEffect, useState } from 'react';
import { getBrand, onBrand } from '../config/brand';

export function useBrand() {
  const [brand, setBrand] = useState(getBrand);
  useEffect(() => onBrand(setBrand), []);
  return brand;
}

export default useBrand;
