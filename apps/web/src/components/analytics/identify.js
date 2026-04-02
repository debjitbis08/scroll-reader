export async function identifyUser() {
  if (!window.posthog) return;
  const cookieConsent = localStorage.getItem("cookie_consent");
  const bodyUserId = document.body.dataset.userId;
  const bodyUserEmail = document.body.dataset.userEmail;
  if (bodyUserId) {
    if (bodyUserEmail) {
      posthog.identify(bodyUserId, { email: bodyUserEmail });
    } else {
      posthog.identify(bodyUserId);
    }
    return;
  }

  if (cookieConsent === "no") {
    const { getThumbmark } = await import("@thumbmarkjs/thumbmarkjs");
    const response = await getThumbmark();

    posthog.identify(response.thumbmark, { anon: true });
    return;
  }

  if (cookieConsent === "yes") {
    let id = localStorage.getItem("anon_id");
    if (!id) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      id = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      localStorage.setItem("anon_id", id);
    }

    posthog.identify(id, { anon: true });
  }
}
