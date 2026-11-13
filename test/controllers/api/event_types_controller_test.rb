require "test_helper"

class Api::EventTypesControllerTest < ActionDispatch::IntegrationTest
  test "lists the public event type catalog" do
    EventType.create!(name: "Consultation", description: "Talk through a question", duration_minutes: 30)

    get api_event_types_path, as: :json

    assert_response :success
    assert_equal "Consultation", response.parsed_body.first.fetch("name")
    assert_equal 30, response.parsed_body.first.fetch("durationMinutes")
  end

  test "creates an event type and returns its server generated ID" do
    post api_event_types_path,
      params: { name: "Consultation", description: "Talk through a question", durationMinutes: 30 },
      as: :json

    assert_response :created
    assert_predicate response.parsed_body.fetch("id"), :present?
    assert_equal 30, response.parsed_body.fetch("durationMinutes")
  end

  test "returns field errors for invalid event type data" do
    post api_event_types_path,
      params: { name: "", description: "", durationMinutes: 0 },
      as: :json

    assert_response :unprocessable_entity
    assert_equal "validation_error", response.parsed_body.dig("error", "code")
    fields = response.parsed_body.dig("error", "fieldErrors").map { |error| error.fetch("field") }
    assert_includes fields, "durationMinutes"
  end
end
