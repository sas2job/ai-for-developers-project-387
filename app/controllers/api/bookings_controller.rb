module Api
  class BookingsController < ApplicationController
    def upcoming
      bookings = Booking.upcoming

      render json: bookings.map { |booking| serialize_summary(booking) }
    end

    def create
      event_type = EventType.find_by(id: event_type_id)
      return render_error("not_found", "Тип встречи не найден.", :not_found) unless event_type

      starts_at = parse_starts_at
      return render_invalid_start unless starts_at
      return render_invalid_start unless Availability::Slots.valid_start?(event_type: event_type, starts_at: starts_at)

      booking = event_type.bookings.build(
        starts_at: starts_at,
        ends_at: starts_at + event_type.duration_minutes.minutes,
        guest_name: params[:guestName],
        guest_email: params[:guestEmail],
      )

      if booking.save
        render json: serialize(booking), status: :created
      else
        render_validation_error(booking)
      end
    rescue ActiveRecord::StatementInvalid => error
      raise unless exclusion_violation?(error)

      render_error("slot_unavailable", "Выбранное время уже занято.", :conflict)
    end

    private

    def event_type_id
      Integer(params[:eventTypeId], 10)
    rescue ArgumentError, TypeError
      nil
    end

    def parse_starts_at
      value = params[:startsAt]
      return unless value.is_a?(String) && value.end_with?("Z")

      Time.iso8601(value)
    rescue ArgumentError
      nil
    end

    def serialize(booking)
      {
        id: booking.id.to_s,
        eventTypeId: booking.event_type_id.to_s,
        eventTypeName: booking.event_type.name,
        startsAt: booking.starts_at.utc.iso8601,
        endsAt: booking.ends_at.utc.iso8601,
        guestName: booking.guest_name,
        guestEmail: booking.guest_email
      }
    end

    def serialize_summary(booking)
      {
        id: booking.id.to_s,
        eventTypeId: booking.event_type_id.to_s,
        eventTypeName: booking.event_type.name,
        startsAt: booking.starts_at.utc.iso8601,
        endsAt: booking.ends_at.utc.iso8601,
        guestName: booking.guest_name
      }
    end

    def render_invalid_start
      render json: {
        error: {
          code: "validation_error",
          message: "Укажите корректное время начала в формате RFC 3339 UTC с суффиксом Z.",
          fieldErrors: [ { field: "startsAt", message: "Укажите время в формате RFC 3339 UTC с суффиксом Z." } ]
        }
      }, status: :unprocessable_entity
    end

    def render_validation_error(booking)
      render json: {
        error: {
          code: "validation_error",
          message: booking.errors.full_messages.to_sentence,
          fieldErrors: booking.errors.map do |error|
            { field: error.attribute.to_s.camelize(:lower), message: error.message }
          end
        }
      }, status: :unprocessable_entity
    end

    def render_error(code, message, status)
      render json: { error: { code: code, message: message } }, status: status
    end

    def exclusion_violation?(error)
      error.cause.is_a?(PG::ExclusionViolation)
    end
  end
end
