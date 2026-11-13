require "test_helper"

class AdminControllerTest < ActionDispatch::IntegrationTest
  test "shows the event type form and an empty state" do
    get admin_path

    assert_response :success
    assert_select "h1", "Управление календарём"
    assert_select "form[action='#{admin_event_types_path}']"
    assert_select "p", text: "Вы ещё не создали ни одного типа встречи."
    assert_select "p", text: "Предстоящих встреч пока нет."
  end

  test "creates an event type from the owner page" do
    assert_difference("EventType.count", 1) do
      post admin_event_types_path, params: {
        event_type: { name: "Консультация", description: "Обсудить вопрос", duration_minutes: 30 }
      }
    end

    assert_redirected_to admin_path
    follow_redirect!
    assert_select "li", text: /Консультация/
  end

  test "shows validation errors beside invalid fields" do
    post admin_event_types_path, params: {
      event_type: { name: "", description: "", duration_minutes: 0 }
    }

    assert_response :unprocessable_entity
    assert_select ".field-error", minimum: 3
  end

  test "lists upcoming bookings in order without guest emails or event type descriptions" do
    first_type = EventType.create!(name: "First type", description: "Private first description", duration_minutes: 30)
    second_type = EventType.create!(name: "Second type", description: "Private second description", duration_minutes: 30)
    later = Time.current.beginning_of_day + 2.days + 9.hours
    sooner = Time.current.beginning_of_day + 1.day + 9.hours
    first_type.bookings.create!(
      starts_at: later,
      ends_at: later + 30.minutes,
      guest_name: "Later guest",
      guest_email: "later-private@example.com"
    )
    second_type.bookings.create!(
      starts_at: sooner,
      ends_at: sooner + 30.minutes,
      guest_name: "Sooner guest",
      guest_email: "sooner-private@example.com"
    )

    get admin_path

    assert_response :success
    assert_select ".admin-booking-list li", count: 2
    assert_operator response.body.index("Sooner guest"), :<, response.body.index("Later guest")
    assert_not_includes response.body, "private@example.com"
    assert_not_includes response.body, "Private first description"
  end
end
