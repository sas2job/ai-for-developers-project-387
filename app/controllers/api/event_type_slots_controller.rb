module Api
  class EventTypeSlotsController < ApplicationController
    def index
      event_type = EventType.find_by(id: integer_event_type_id)
      return render_error("not_found", "Тип встречи не найден.", :not_found) unless event_type

      date = parse_date
      return render_invalid_date unless date && Availability::Slots.date_in_window?(date)

      slots = Availability::Slots.new(event_type: event_type, date: date).call
      render json: slots.map { |slot| serialize(slot) }
    end

    private

    def integer_event_type_id
      Integer(params[:event_type_id], 10)
    rescue ArgumentError, TypeError
      nil
    end

    def parse_date
      value = params[:date]
      return unless value.is_a?(String)

      date = Date.iso8601(value)
      date if date.iso8601 == value
    rescue ArgumentError
      nil
    end

    def serialize(slot)
      {
        startsAt: slot.starts_at.utc.iso8601,
        endsAt: slot.ends_at.utc.iso8601
      }
    end

    def render_invalid_date
      render json: {
        error: {
          code: "validation_error",
          message: "Дата должна быть в 14-дневном окне и иметь формат YYYY-MM-DD.",
          fieldErrors: [ { field: "date", message: "Выберите дату в пределах доступного окна." } ]
        }
      }, status: :unprocessable_entity
    end

    def render_error(code, message, status)
      render json: { error: { code: code, message: message } }, status: status
    end
  end
end
