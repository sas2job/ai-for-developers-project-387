module Api
  class EventTypesController < ApplicationController
    def index
      render json: EventType.order(:id).map { |event_type| serialize(event_type) }
    end

    def create
      event_type = EventType.new(event_type_params)

      if event_type.save
        render json: serialize(event_type), status: :created
      else
        render json: validation_error(event_type), status: :unprocessable_entity
      end
    end

    private

    def event_type_params
      params.permit(:name, :description, :durationMinutes)
        .to_h
        .transform_keys { |key| key.underscore }
    end

    def serialize(event_type)
      {
        id: event_type.id.to_s,
        name: event_type.name,
        description: event_type.description,
        "durationMinutes" => event_type.duration_minutes
      }
    end

    def validation_error(event_type)
      {
        error: {
          code: "validation_error",
          message: event_type.errors.full_messages.to_sentence,
          fieldErrors: event_type.errors.map do |error|
            { field: error.attribute.to_s.camelize(:lower), message: error.message }
          end
        }
      }
    end
  end
end
