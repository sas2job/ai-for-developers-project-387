require "test_helper"

class Api::EventTypeSlotsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @event_type = EventType.create!(name: "Consultation", description: "Talk", duration_minutes: 30)
  end

  test "returns available slots with UTC Z timestamps" do
    date = Availability::Slots.window_dates.find { |candidate| !candidate.saturday? && !candidate.sunday? }

    get api_event_type_slots_path(@event_type.id), params: { date: date.iso8601 }, as: :json

    assert_response :success
    assert_kind_of Array, response.parsed_body
    assert_match(/Z\z/, response.parsed_body.first.fetch("startsAt")) if response.parsed_body.any?
  end

  test "returns 404 for an unknown event type" do
    get api_event_type_slots_path("999999"), params: { date: Date.current.iso8601 }, as: :json

    assert_response :not_found
    assert_equal "not_found", response.parsed_body.dig("error", "code")
  end

  test "returns 422 for a date outside the booking window" do
    outside_window = Availability::Slots.window_dates.last + 1

    get api_event_type_slots_path(@event_type.id), params: { date: outside_window.iso8601 }, as: :json

    assert_response :unprocessable_entity
    assert_equal "validation_error", response.parsed_body.dig("error", "code")
  end
end
