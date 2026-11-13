import { Controller } from "@hotwired/stimulus";
import { ApiClient, DefaultApi } from "../generated/src";

export default class extends Controller {
  static targets = [
    "confirmation",
    "confirmationDetails",
    "form",
    "guestEmail",
    "guestEmailError",
    "guestName",
    "guestNameError",
    "selectedTime",
    "selectedTimeLabel",
    "slot",
    "slots",
    "status",
    "submit",
  ];

  static values = { date: String, eventTypeId: String };

  connect() {
    this.api = new DefaultApi(new ApiClient(window.location.origin));
  }

  selectSlot(event) {
    this.selectedStartsAt = event.currentTarget.dataset.startsAt;

    this.slotTargets.forEach((slot) => {
      slot.setAttribute("aria-pressed", String(slot === event.currentTarget));
    });

    this.selectedTimeTarget.textContent = this.formatTime(event.currentTarget.dataset.startsAt);
    this.selectedTimeLabelTarget.hidden = false;
    this.formTarget.hidden = false;
    this.statusTarget.textContent = "";
    this.clearFieldErrors();
  }

  submit(event) {
    event.preventDefault();

    if (!this.selectedStartsAt) {
      this.statusTarget.textContent = "Сначала выберите свободное время.";
      return;
    }

    this.clearFieldErrors();
    this.submitTarget.disabled = true;
    this.statusTarget.textContent = "Отправляем запись…";

    this.api.bookingsCreate(
      {
        eventTypeId: this.eventTypeIdValue,
        startsAt: this.selectedStartsAt,
        guestName: this.guestNameTarget.value.trim(),
        guestEmail: this.guestEmailTarget.value.trim(),
      },
      (error, booking, response) => {
        this.submitTarget.disabled = false;

        if (error) {
          this.handleError(error, response);
          return;
        }

        this.showConfirmation(booking);
      },
    );
  }

  handleError(error, response) {
    const status = response?.status ?? error?.status;
    const body = response?.body ?? error?.response?.body;
    const payload = body?.error;

    if (status === 409) {
      this.selectedStartsAt = null;
      this.selectedTimeLabelTarget.hidden = true;
      this.statusTarget.textContent =
        "Это время только что заняли. Выберите другой свободный слот.";
      this.refreshSlots();
      return;
    }

    if (status === 422 && payload?.fieldErrors) {
      this.showFieldErrors(payload.fieldErrors);
      this.statusTarget.textContent = payload.message ?? "Проверьте введённые данные.";
      return;
    }

    this.statusTarget.textContent =
      payload?.message ?? "Не удалось создать запись. Попробуйте ещё раз.";
  }

  refreshSlots() {
    this.api.eventTypesSlots(this.eventTypeIdValue, this.dateValue, (error, slots) => {
      if (error) {
        this.statusTarget.textContent =
          "Время заняли. Не удалось обновить список слотов; обновите страницу.";
        return;
      }

      this.renderSlots(slots);
    });
  }

  renderSlots(slots) {
    this.slotsTarget.replaceChildren();

    slots.forEach((slot) => {
      const startsAt = this.timestampValue(slot.startsAt);
      const endsAt = this.timestampValue(slot.endsAt);
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "available-slots__button";
      button.dataset.bookingTarget = "slot";
      button.dataset.action = "booking#selectSlot";
      button.dataset.startsAt = startsAt;
      button.setAttribute("aria-pressed", "false");

      const start = document.createElement("time");
      start.dateTime = startsAt;
      start.textContent = this.formatTime(startsAt);
      const separator = document.createElement("span");
      separator.textContent = "–";
      const end = document.createElement("time");
      end.dateTime = endsAt;
      end.textContent = this.formatTime(endsAt);

      button.append(start, separator, end);
      item.append(button);
      this.slotsTarget.append(item);
    });

    if (slots.length === 0) {
      const emptyState = document.createElement("li");
      emptyState.className = "available-slots__empty";
      emptyState.textContent = "На эту дату больше нет свободных слотов.";
      this.slotsTarget.append(emptyState);
    }
  }

  showFieldErrors(fieldErrors) {
    const targets = {
      guestName: this.guestNameErrorTarget,
      guestEmail: this.guestEmailErrorTarget,
    };

    fieldErrors.forEach(({ field, message }) => {
      const target = targets[field];
      if (!target) return;

      target.textContent = message;
      target.hidden = false;
    });
  }

  clearFieldErrors() {
    [this.guestNameErrorTarget, this.guestEmailErrorTarget].forEach((target) => {
      target.textContent = "";
      target.hidden = true;
    });
  }

  showConfirmation(booking) {
    const dateTimeFormat = new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      dateStyle: "long",
      timeStyle: "short",
    });

    const start = dateTimeFormat.format(new Date(booking.startsAt));
    const end = new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(booking.endsAt));

    this.confirmationDetailsTarget.textContent = `${booking.eventTypeName}: ${start}–${end}.`;
    this.formTarget.hidden = true;
    this.selectedTimeLabelTarget.hidden = true;
    this.slotsTarget.hidden = true;
    this.confirmationTarget.hidden = false;
    this.statusTarget.textContent = "";
  }

  formatTime(timestamp) {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(timestamp));
  }

  timestampValue(timestamp) {
    return timestamp instanceof Date ? timestamp.toISOString() : timestamp;
  }
}
