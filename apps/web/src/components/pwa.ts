import { registerSW } from "virtual:pwa-register";

window.addEventListener("load", () => {
  const pwaToast = document.querySelector<HTMLDivElement>("#pwa-toast")!;
  const pwaToastMessage = pwaToast.querySelector<HTMLDivElement>(
    ".message #toast-message",
  )!;
  const pwaCloseBtn = pwaToast.querySelector<HTMLButtonElement>("#pwa-close")!;
  const pwaRefreshBtn =
    pwaToast.querySelector<HTMLButtonElement>("#pwa-refresh")!;
  const defaultCloseBtnText = pwaCloseBtn.textContent?.trim() || "Not Now";

  let refreshSW: ((reloadPage?: boolean) => Promise<void>) | undefined;

  const refreshCallback = () => refreshSW?.(true);

  const hidePwaToast = (raf = false) => {
    if (raf) {
      requestAnimationFrame(() => hidePwaToast(false));
      return;
    }
    if (pwaToast.classList.contains("refresh"))
      pwaRefreshBtn.removeEventListener("click", refreshCallback);

    pwaToast.classList.remove("show", "refresh");
  };
  const showPwaToast = (offline: boolean) => {
    pwaCloseBtn.textContent = offline ? "Ok" : defaultCloseBtnText;
    if (!offline) pwaRefreshBtn.addEventListener("click", refreshCallback);
    requestAnimationFrame(() => {
      hidePwaToast(false);
      if (!offline) pwaToast.classList.add("refresh");
      pwaToast.classList.add("show");
    });
  };

  pwaCloseBtn.addEventListener("click", () => hidePwaToast(true));

  refreshSW = registerSW({
    immediate: true,
    onOfflineReady() {
      pwaToastMessage.innerHTML = "Application is ready to work offline.";
      showPwaToast(true);
    },
    onNeedRefresh() {
      pwaToastMessage.innerHTML = [
        '<p class="text-base font-bold mb-2">A new version is available.</p>',
        '<p class="text-sm opacity-70 mb-2">Refresh to see the latest changes.</p>',
      ].join("\n");
      showPwaToast(false);
    },
    onRegisteredSW(swScriptUrl) {
      console.log("SW registered: ", swScriptUrl);
    },
  });
});
