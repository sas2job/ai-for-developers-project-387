require "test_helper"

class HomeControllerTest < ActionDispatch::IntegrationTest
  test "home page links to booking and calendar management" do
    get root_path

    assert_response :success
    assert_select "h1", "Запись на звонок"
    assert_select "a[href='/book']", text: "Записаться", count: 2
    assert_select "a[href='/admin']", text: "Управление календарём"
    assert_select "h2", "Возможности"
  end

  test "booking catalog shows an empty state when no event types exist" do
    get book_path

    assert_response :success
    assert_select "h1", "Каталог типов встреч"
    assert_select "h2", "Пока нет типов встреч"
    assert_select "a[href='/']", text: "На главную"
  end

  test "guest can select an event type and browse dates and available starts" do
    event_type = EventType.create!(name: "Консультация", description: "Обсудить вопрос", duration_minutes: 30)
    date = Availability::Slots.window_dates.find { |candidate| !candidate.saturday? && !candidate.sunday? }

    get book_path(event_type_id: event_type.id, date: date.iso8601)

    assert_response :success
    assert_select "h1", "Консультация"
    assert_select ".calendar-days__link", count: 14
    assert_select ".available-slots li", minimum: 1
    assert_select "button[data-action='booking#selectSlot']", minimum: 1
    assert_select "form[data-action='submit->booking#submit'][hidden]"
    assert_select "input[name='guestName']"
    assert_select "input[name='guestEmail']"
    assert_select "section[data-booking-target='confirmation'][hidden]"
  end

  test "health endpoint responds successfully" do
    get "/api/health"

    assert_response :success
    assert_equal({ "status" => "ok" }, response.parsed_body)
  end
end
