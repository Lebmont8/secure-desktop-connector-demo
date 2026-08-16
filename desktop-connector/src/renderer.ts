import type {
  DesktopConnectorMockProfileInput,
  DesktopConnectorPairInput,
  DesktopConnectorPublicStatus,
} from "./contracts";

const ERROR_LABELS: Record<string, string> = {
  DESKTOP_KEYCHAIN_UNAVAILABLE:
    "Системное защищённое хранилище недоступно. На Linux нужен Secret Service/KWallet; plaintext fallback запрещён.",
  DESKTOP_CONNECTOR_ALREADY_PAIRED:
    "Этот desktop connector уже привязан к устройству.",
  DESKTOP_CONNECTOR_CRM_URL_INVALID:
    "Укажи только origin CRM, например https://crm.example.com.",
  DESKTOP_CONNECTOR_CRM_URL_INSECURE:
    "CRM должна использовать HTTPS. HTTP разрешён только для localhost.",
  DESKTOP_CONNECTOR_CRM_UNREACHABLE:
    "CRM недоступна или отклонила защищённое соединение.",
  DESKTOP_CONNECTOR_PAIRING_INVALID:
    "Pairing code неверен или уже недействителен.",
  DESKTOP_CONNECTOR_PAIRING_EXPIRED:
    "Pairing code истёк. Создай новый в CRM.",
  DESKTOP_CONNECTOR_PAIRING_ALREADY_USED:
    "Pairing code уже использован.",
  DESKTOP_CONNECTOR_INPUT_INVALID:
    "Проверь заполненные поля.",
  DESKTOP_CONNECTOR_NOT_PAIRED:
    "Сначала привяжи desktop connector к CRM.",
  DESKTOP_CONNECTOR_AUTH_FAILED:
    "CRM отклонила локальную привязку. Если устройство отозвано в CRM, нажми «Забыть локальную привязку» и создай новый pairing code.",
  DESKTOP_CONNECTOR_REVOKED:
    "Устройство отозвано в CRM.",
  DESKTOP_CONNECTOR_RESET_BUSY:
    "Сейчас выполняется heartbeat. Подожди несколько секунд и повтори локальный сброс.",
  DESKTOP_CONNECTOR_OPERATION_FAILED:
    "Операция не выполнена. Секреты не сохранены в логах.",
};

let lastRenderedStatus: DesktopConnectorPublicStatus | null = null;

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing UI element: ${id}`);
  return value as T;
}

function errorLabel(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = Object.keys(ERROR_LABELS).find((candidate) =>
    raw.includes(candidate)
  );
  return code ? ERROR_LABELS[code]! : ERROR_LABELS.DESKTOP_CONNECTOR_OPERATION_FAILED!;
}

function setMessage(message: string, kind: "ok" | "error" = "ok"): void {
  const output = element<HTMLParagraphElement>("operation-message");
  output.textContent = message;
  output.dataset.kind = kind;
}

function setBusy(busy: boolean): void {
  for (const control of document.querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLSelectElement
  >("button, input, select")) {
    control.disabled = busy;
  }
}

function text(id: string, value: string): void {
  element(id).textContent = value;
}

function renderProfiles(status: DesktopConnectorPublicStatus): void {
  const list = element<HTMLUListElement>("profile-list");
  list.replaceChildren();
  if (status.profiles.length === 0) {
    const item = document.createElement("li");
    item.textContent = "Локальных mock-профилей нет.";
    item.className = "muted";
    list.append(item);
    return;
  }
  for (const profile of status.profiles) {
    const item = document.createElement("li");
    const details = document.createElement("span");
    details.textContent = `${profile.platform} · ${profile.profileId} · ${profile.status}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button button-quiet";
    remove.textContent = "Удалить локально";
    remove.addEventListener("click", () => {
      void perform(async () => {
        const updated = await window.secureConnector.removeMockProfile(
          profile.profileId
        );
        render(updated);
        setMessage("Локальный mock-профиль удалён.");
      });
    });
    item.append(details, remove);
    list.append(item);
  }
}

function render(status: DesktopConnectorPublicStatus): void {
  lastRenderedStatus = status;
  text("app-version", status.appVersion);
  text(
    "keychain-status",
    `${status.keychain.available ? "защищено" : "недоступно"} · ${status.keychain.backend}`
  );
  text("pair-status", status.paired ? "привязано" : "не привязано");
  text("device-id", status.deviceId ?? "—");
  text("crm-origin", status.crmBaseUrl ?? "—");
  text(
    "runtime-status",
    status.running
      ? "выполняется"
      : status.lastErrorCode
        ? `ошибка: ${status.lastErrorCode}`
        : status.lastOutcome ?? "ожидает"
  );
  text("last-run", status.lastRunAt ?? "—");
  element<HTMLElement>("pair-card").hidden = status.paired;
  element<HTMLElement>("runtime-card").hidden = !status.paired;
  element<HTMLElement>("mock-card").hidden = !status.paired;
  element<HTMLElement>("reset-card").hidden = !status.paired;
  element<HTMLElement>("auth-reset-hint").hidden =
    status.lastErrorCode !== "DESKTOP_CONNECTOR_AUTH_FAILED";
  renderProfiles(status);
}

async function perform(operation: () => Promise<void>): Promise<void> {
  setBusy(true);
  try {
    await operation();
  } catch (error) {
    await window.secureConnector
      .getStatus()
      .then(render)
      .catch(() => undefined);
    setMessage(errorLabel(error), "error");
  } finally {
    setBusy(false);
  }
}

element<HTMLFormElement>("pair-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void perform(async () => {
    const input: DesktopConnectorPairInput = {
      crmBaseUrl: element<HTMLInputElement>("crm-base-url").value,
      pairingCode: element<HTMLInputElement>("pairing-code").value,
      label: element<HTMLInputElement>("device-label").value,
    };
    const status = await window.secureConnector.pair(input);
    element<HTMLInputElement>("pairing-code").value = "";
    render(status);
    setMessage("Устройство привязано; token и private key сохранены зашифрованно.");
  });
});

element<HTMLFormElement>("mock-profile-form").addEventListener(
  "submit",
  (event) => {
    event.preventDefault();
    void perform(async () => {
      const input: DesktopConnectorMockProfileInput = {
        profileId: element<HTMLInputElement>("profile-id").value,
        platform: element<HTMLSelectElement>("profile-platform").value as "demo",
        accountRef: element<HTMLInputElement>("mock-account-ref").value,
      };
      const status = await window.secureConnector.addMockProfile(input);
      element<HTMLInputElement>("mock-account-ref").value = "";
      render(status);
      setMessage("Mock-профиль записан в зашифрованный локальный vault.");
    });
  }
);

element<HTMLButtonElement>("run-once").addEventListener("click", () => {
  void perform(async () => {
    const status = await window.secureConnector.runOnce();
    render(status);
    setMessage(
      status.lastOutcome === "processed"
        ? "Mock-команда обработана."
        : "Heartbeat отправлен; новых mock-команд нет."
    );
  });
});

element<HTMLButtonElement>("forget-pairing").addEventListener("click", () => {
  if (
    !window.confirm(
      "Сначала отзови устройство в CRM. Удалить с этого компьютера локальный device token, private key, mock-профили и receipts?"
    )
  ) {
    return;
  }
  const previous = lastRenderedStatus;
  void perform(async () => {
    const status = await window.secureConnector.forgetPairing();
    render(status);
    if (previous?.crmBaseUrl) {
      element<HTMLInputElement>("crm-base-url").value =
        previous.crmBaseUrl;
    }
    if (previous?.label) {
      element<HTMLInputElement>("device-label").value = previous.label;
    }
    element<HTMLInputElement>("pairing-code").value = "";
    setMessage(
      "Локальная привязка удалена. Создай новый pairing code в CRM и привяжи устройство заново."
    );
  });
});

void perform(async () => {
  render(await window.secureConnector.getStatus());
});

setInterval(() => {
  void window.secureConnector.getStatus().then(render).catch(() => undefined);
}, 5_000);
