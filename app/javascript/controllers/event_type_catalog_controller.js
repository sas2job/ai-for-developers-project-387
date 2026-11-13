import { Controller } from "@hotwired/stimulus";
import { ApiClient, DefaultApi } from "../generated/src";

export default class extends Controller {
  static targets = ["empty", "list", "status"];

  connect() {
    this.api = new DefaultApi(new ApiClient(window.location.origin));
    this.api.eventTypesList((error, eventTypes) => {
      if (error) {
        this.statusTarget.textContent = "Не удалось загрузить типы встреч. Обновите страницу.";
        return;
      }

      this.statusTarget.textContent = "";
      if (eventTypes.length === 0) {
        this.emptyTarget.hidden = false;
        return;
      }

      eventTypes.forEach((eventType) => this.listTarget.append(this.cardFor(eventType)));
    });
  }

  cardFor(eventType) {
    const card = document.createElement("article");
    card.className = "event-type-card";

    const title = document.createElement("h2");
    title.textContent = eventType.name;

    const description = document.createElement("p");
    description.textContent = eventType.description;

    const duration = document.createElement("p");
    duration.className = "event-type-card__duration";
    duration.textContent = `${eventType.durationMinutes} мин.`;

    const link = document.createElement("a");
    link.className = "button button--secondary";
    link.textContent = "Выбрать время";
    const url = new URL("/book", window.location.origin);
    url.searchParams.set("event_type_id", eventType.id);
    link.href = `${url.pathname}?${url.searchParams.toString()}`;

    card.append(title, description, duration, link);
    return card;
  }
}
