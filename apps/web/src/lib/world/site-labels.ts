"use client";

/**
 * Screen positions of the site labels. The labels are ordinary DOM elements in the HUD layer
 * (beneath the panels); a component inside the 3D canvas projects each site's anchor every frame
 * and moves its element directly, so labels follow the camera without re-rendering React.
 */
const elements = new Map<string, HTMLElement>();

export function registerSiteLabel(siteId: string, el: HTMLElement | null): void {
  if (el) elements.set(siteId, el);
  else elements.delete(siteId);
}

export function siteLabelElement(siteId: string): HTMLElement | undefined {
  return elements.get(siteId);
}
