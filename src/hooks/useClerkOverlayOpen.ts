import { useEffect } from "react"

/**
 * Toggles `body.cl-overlay-open` when Clerk overlays (checkout/modal/drawer/backdrop)
 * are actually visible. This prevents app chrome (e.g. sticky topbar) from capturing
 * clicks or visually overlaying Clerk UI, and ensures it re-enables after close.
 */
export function useClerkOverlayOpen() {
  useEffect(() => {
    const body = document.body
    const selector =
      ".cl-modalBackdrop, .cl-modalOverlay, .cl-checkout, .cl-drawer, .cl-modal, [class*='cl-modalBackdrop'], [class*='cl-modalOverlay'], [class*='cl-checkout'], [class*='cl-drawer'], [class*='cl-modal']"

    const isVisible = (el: Element) => {
      const node = el as HTMLElement
      const style = window.getComputedStyle(node)
      if (style.display === "none") return false
      if (style.visibility === "hidden") return false
      if (style.opacity === "0") return false
      const rect = node.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }

    let raf = 0
    const scheduleCheck = () => {
      if (raf) return
      raf = window.requestAnimationFrame(() => {
        raf = 0
        const open = Array.from(document.querySelectorAll(selector)).some(isVisible)
        body.classList.toggle("cl-overlay-open", open)
      })
    }

    scheduleCheck()
    const observer = new MutationObserver(scheduleCheck)
    observer.observe(body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "aria-hidden", "data-state"],
    })

    return () => {
      observer.disconnect()
      body.classList.remove("cl-overlay-open")
      if (raf) window.cancelAnimationFrame(raf)
    }
  }, [])
}


