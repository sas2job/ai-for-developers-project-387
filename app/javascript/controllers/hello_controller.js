import { Controller } from "@hotwired/stimulus";
import { ApiClient, DefaultApi } from "../generated/src";

export default class extends Controller {
  connect() {
    const client = new ApiClient(window.location.origin);

    new DefaultApi(client).getHealth((error, data) => {
      this.element.textContent =
        !error && data?.status === "ok"
          ? "Интерфейс и API подключены"
          : "Не удалось связаться с API";
    });
  }
}
