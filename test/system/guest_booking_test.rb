require "application_system_test_case"

class GuestBookingTest < ApplicationSystemTestCase
  setup do
    Booking.delete_all
    EventType.delete_all
    @event_type = EventType.create!(name: "Консультация", description: "Обсудить вопрос", duration_minutes: 30)
    @date = available_date
    visit book_path(event_type_id: @event_type.id, date: @date.iso8601)
  end

  teardown do
    Booking.delete_all
    EventType.delete_all
  end

  test "guest sees event types loaded from the public API" do
    visit book_path

    assert_text "Каталог типов встреч"
    assert_text "Консультация"
    assert_text "Обсудить вопрос"
    assert_text "30 мин."
    assert_link "Выбрать время", href: book_path(event_type_id: @event_type.id)
  end

  test "guest can create a booking and see a confirmation without email or call link delivery" do
    visit book_path
    assert_text "Каталог типов встреч"
    click_link "Выбрать время", href: book_path(event_type_id: @event_type.id)
    click_link @date.strftime("%d.%m"), href: book_path(event_type_id: @event_type.id, date: @date.iso8601)
    selected_slot = page.first("button[data-booking-target='slot']")
    selected_start = Time.iso8601(selected_slot["data-starts-at"])
    selected_slot.click
    fill_in "Имя", with: "Анна"
    fill_in "Email", with: "anna@example.com"
    click_button "Подтвердить запись"

    assert_text "Запись подтверждена"
    assert_text "Консультация"
    assert_text "Письмо-приглашение и ссылка на звонок не отправляются."
    assert_equal 1, Booking.count

    visit admin_path
    assert_text "Предстоящие встречи"
    assert_text "Консультация"
    assert_text "Анна"
    assert_text @date.strftime("%d.%m.%Y")
    assert_text selected_start.in_time_zone(Availability::Slots::TIME_ZONE).strftime("%H:%M")
  end

  test "guest keeps contacts and selects another time after a slot conflict" do
    choose_first_slot
    starts_at = page.first("button[data-booking-target='slot']")["data-starts-at"]
    fill_in "Имя", with: "Анна"
    fill_in "Email", with: "anna@example.com"

    competing_start = Time.iso8601(starts_at)
    @event_type.bookings.create!(
      starts_at: competing_start,
      ends_at: competing_start + @event_type.duration_minutes.minutes,
      guest_name: "Другой гость",
      guest_email: "other@example.com"
    )

    click_button "Подтвердить запись"

    assert_text "Это время только что заняли. Выберите другой свободный слот."
    assert_equal "Анна", page.find_field("Имя").value
    assert_equal "anna@example.com", page.find_field("Email").value
    assert_no_selector "button[data-starts-at='#{starts_at}']"

    choose_first_slot
    click_button "Подтвердить запись"

    assert_text "Запись подтверждена"
    assert_equal 2, Booking.count
  end

  test "guest sees validation errors beside contact fields" do
    choose_first_slot
    page.execute_script("document.querySelector('#guest-name').removeAttribute('required'); document.querySelector('#guest-email').type = 'text';")
    fill_in "Имя", with: ""
    fill_in "Email", with: "invalid-email"
    click_button "Подтвердить запись"

    assert_selector "#guest-name + .field-error:not([hidden])"
    assert_selector "#guest-email + .field-error:not([hidden])"
    assert_equal 0, Booking.count
  end

  test "owner sees upcoming bookings in order without guest emails" do
    later_type = EventType.create!(name: "Планирование", description: "Не показывать описание", duration_minutes: 30)
    later = Time.current.beginning_of_day + 2.days + 9.hours
    sooner = Time.current.beginning_of_day + 1.day + 9.hours
    @event_type.bookings.create!(
      starts_at: later,
      ends_at: later + 30.minutes,
      guest_name: "Позже",
      guest_email: "later-private@example.com"
    )
    later_type.bookings.create!(
      starts_at: sooner,
      ends_at: sooner + 30.minutes,
      guest_name: "Раньше",
      guest_email: "sooner-private@example.com"
    )

    visit admin_path

    assert_text "Предстоящие встречи"
    assert_operator page.text.index("Раньше"), :<, page.text.index("Позже")
    assert_no_text "private@example.com"
    assert_no_text "Не показывать описание"
  end

  private

  def available_date
    Availability::Slots.window_dates.find do |date|
      next false if date.saturday? || date.sunday?

      ActiveSupport::TimeZone[Availability::Slots::TIME_ZONE]
        .local(date.year, date.month, date.day, 9) > Time.current.in_time_zone(Availability::Slots::TIME_ZONE)
    end
  end

  def choose_first_slot
    page.first("button[data-booking-target='slot']").click
  end
end
