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

  test "filters upcoming meetings by type from the URL in start time order" do
    selected_type = EventType.create!(name: "Консультация", description: "Обсудить вопрос", duration_minutes: 30)
    other_type = EventType.create!(name: "Планирование", description: "Составить план", duration_minutes: 30)
    today = Time.current.beginning_of_day
    sooner = today + 1.day + 9.hours
    later = today + 3.days + 9.hours

    create_booking(selected_type, later, "Позже")
    create_booking(other_type, today + 2.days + 9.hours, "Другой тип")
    create_booking(selected_type, today - 1.day + 9.hours, "Прошедшая")
    create_booking(selected_type, sooner, "Раньше")

    get admin_path, params: { event_type_id: selected_type.id }

    assert_response :success
    assert_select ".admin-booking-list time" do |times|
      assert_equal [ sooner.utc.iso8601, later.utc.iso8601 ], times.map { |time| time["datetime"] }
    end
    assert_not_includes response.body, "private@example.com"
  end

  test "offers a type without upcoming meetings and explains its empty list" do
    empty_type = EventType.create!(name: "Консультация", description: "Обсудить вопрос", duration_minutes: 30)
    other_type = EventType.create!(name: "Планирование", description: "Составить план", duration_minutes: 30)
    create_booking(empty_type, 1.day.ago, "Прошедшая")
    create_booking(other_type, 1.day.from_now, "Другой тип")

    get admin_path, params: { event_type_id: empty_type.id }

    assert_response :success
    assert_select "select[name='event_type_id']" do
      assert_select "option[value='']", "Все типы"
      assert_select "option[value='#{empty_type.id}'][selected]", "Консультация"
      assert_select "option[value='#{other_type.id}']", "Планирование"
    end
    assert_select ".admin-booking-list", count: 0
    assert_select "p", text: "Для типа «Консультация» пока нет предстоящих встреч."
  end

  test "distinguishes matching type names and keeps the reset option distinct" do
    first_type = EventType.create!(name: "Первая консультация", description: "Первый тип", duration_minutes: 30)
    second_type = EventType.create!(name: "Первая консультация", description: "Второй тип", duration_minutes: 30)
    spaced_type = EventType.create!(name: "Первая  консультация", description: "Третий тип", duration_minutes: 45)
    reset_named_type = EventType.create!(name: "Все типы", description: "Четвёртый тип", duration_minutes: 45)
    create_booking(first_type, 1.day.from_now, "Гость первого типа")
    create_booking(second_type, 2.days.from_now, "Гость второго типа")

    get admin_path, params: { event_type_id: second_type.id }

    assert_response :success
    assert_select "select[name='event_type_id']" do
      assert_select "option", text: "Все типы", count: 1
      assert_select "option[value='']", "Все типы"
      assert_select "option[value='#{first_type.id}']", "Первая консультация (30 мин., №#{first_type.id})"
      assert_select "option[value='#{second_type.id}'][selected]", "Первая консультация (30 мин., №#{second_type.id})"
      assert_select "option[value='#{spaced_type.id}']", "Первая консультация (45 мин., №#{spaced_type.id})"
      assert_select "option[value='#{reset_named_type.id}']", "Все типы (45 мин., №#{reset_named_type.id})"
    end
    assert_select ".admin-booking-list li", count: 1, text: /Гость второго типа/
  end

  test "shows all upcoming meetings when the requested type is invalid or missing" do
    first_type = EventType.create!(name: "Консультация", description: "Обсудить вопрос", duration_minutes: 30)
    second_type = EventType.create!(name: "Планирование", description: "Составить план", duration_minutes: 30)
    create_booking(first_type, 1.day.from_now, "Раньше")
    create_booking(second_type, 2.days.from_now, "Позже")

    [ "", "#{first_type.id}extra", [ first_type.id ], { id: first_type.id }, second_type.id + 1 ].each do |invalid_id|
      get admin_path, params: { event_type_id: invalid_id }

      assert_response :success
      assert_select "select[name='event_type_id'] option[selected]", count: 0
      assert_select ".admin-booking-list li", count: 2
    end
  end

  private

  def create_booking(event_type, starts_at, guest_name)
    event_type.bookings.create!(
      starts_at: starts_at,
      ends_at: starts_at + 30.minutes,
      guest_name: guest_name,
      guest_email: "private@example.com"
    )
  end
end
